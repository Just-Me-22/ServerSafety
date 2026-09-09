/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Channel, Guild, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildChannelStore, GuildRoleStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Select, Text, TextInput, Toasts, useRef, useState } from "@webpack/common";

import { ChannelEdit } from "./ChannelEdit";
import { record } from "./History";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const CATEGORY = 4;

const KINDS = [
    { label: "Text", value: 0 },
    { label: "Voice", value: 2 },
    { label: "Category", value: CATEGORY },
    { label: "Announcement", value: 5 },
    { label: "Stage", value: 13 },
    { label: "Forum", value: 15 }
];

const KIND_NAMES: Record<number, string> = {
    0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum"
};

/** a 400 from discord is usually Invalid Form Body, which says nothing. the reason sits
 *  in a nested _errors array keyed by the field that was wrong. */
function why(error: any): string {
    const body = error?.body;
    if (!body) return String(error);

    const walk = (node: any): string | undefined => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node._errors) && node._errors[0]?.message) return node._errors[0].message;
        for (const value of Object.values(node)) {
            const found = walk(value);
            if (found) return found;
        }
    };

    return walk(body.errors) ?? body.message ?? String(error);
}

const GAP = 700;
const TYPE_IT_OUT = 5;

function everyChannel(guildId: string): Channel[] {
    const buckets = GuildChannelStore.getChannels(guildId);
    return [
        ...(buckets?.[CATEGORY] ?? []),
        ...(buckets?.SELECTABLE ?? []),
        ...(buckets?.VOCAL ?? [])
    ].map((entry: { channel: Channel; }) => entry.channel);
}

/** Discord answers a 429 with how long to wait, so waiting that out beats guessing at
 *  a safe rate. one retry only: a second 429 means the limit is longer than this job */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const wait = (error as any)?.body?.retry_after;
        if ((error as any)?.status !== 429 || wait == null) throw error;

        await new Promise(resolve => setTimeout(resolve, (wait + 0.5) * 1000));
        return await run();
    }
}

function Channels({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const all = everyChannel(guild.id);
    const categories = all.filter(channel => channel.type === CATEGORY).sort((a, b) => a.position - b.position);
    const mayCreate = PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, guild);

    const [name, setName] = useState("");
    const [kind, setKind] = useState(0);
    const [parent, setParent] = useState("");
    const [topic, setTopic] = useState("");
    const [nsfw, setNsfw] = useState(false);
    const [slow, setSlow] = useState("");
    const [editing, setEditing] = useState<string | null>(null);
    const [priv, setPriv] = useState(false);
    const [viewers, setViewers] = useState<string[]>([]);

    const [picked, setPicked] = useState<string[]>([]);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();
    // a ref rather than state: the loop below captures its variables when it starts, so
    // a state update from the stop button would never be visible to a run in progress
    const stop = useRef(false);

    const toggle = (id: string) =>
        setPicked(current => current.includes(id) ? current.filter(one => one !== id) : [...current, id]);

    const deletable = (channel: Channel) => PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);
    // stage and announcement channels only exist in a community server
    const kinds = guild.features.has("COMMUNITY") ? KINDS : KINDS.filter(one => one.value !== 5 && one.value !== 13);
    const confirmed = picked.length <= TYPE_IT_OUT || typed.trim() === guild.name;

    const ordered: { channel: Channel; indented: boolean; }[] = [];
    for (const category of categories) {
        ordered.push({ channel: category, indented: false });
        for (const child of all.filter(one => one.parent_id === category.id).sort((a, b) => a.position - b.position))
            ordered.push({ channel: child, indented: true });
    }
    for (const loose of all.filter(one => one.type !== CATEGORY && !one.parent_id).sort((a, b) => a.position - b.position))
        ordered.push({ channel: loose, indented: false });

    async function create() {
        setBusy(true);
        try {
            const seconds = Number(slow);
            const body: Record<string, unknown> = { name: name.trim(), type: kind };

            if (parent && kind !== CATEGORY) body.parent_id = parent;
            if (topic.trim()) body.topic = topic.trim();
            if (nsfw) body.nsfw = true;
            if (priv) {
                const view = String(PermissionsBits.VIEW_CHANNEL);
                body.permission_overwrites = [
                    { id: guild.id, type: 0, deny: view },
                    ...viewers.map(id => ({ id, type: 0, allow: view }))
                ];
            }
            if (Number.isFinite(seconds) && seconds > 0) body.rate_limit_per_user = Math.min(21600, Math.floor(seconds));

            await withRetry(() => RestAPI.post({
                url: `/guilds/${guild.id}/channels`,
                body,
                reason: "Server Safety: channel created"
            } as any));

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Created ${KIND_NAMES[kind]} channel ${name.trim()}.`,
                targets: []
            });

            setName("");
            setTopic("");
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `Created ${name.trim()}` });
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${why(error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        setBusy(true);
        stop.current = false;

        const gone: string[] = [];
        try {
            for (const id of picked) {
                if (stop.current) break;

                const channel = all.find(one => one.id === id);
                await withRetry(() => RestAPI.del({
                    url: `/channels/${id}`,
                    reason: "Server Safety: channel deleted"
                } as any));

                gone.push(channel?.name ?? id);
                setProgress(`deleted ${gone.length} of ${picked.length}`);

                if (gone.length < picked.length) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${gone.length}: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            if (gone.length) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Deleted ${plural(gone.length, "channel")}: ${gone.join(", ")}. This cannot be undone.`,
                    targets: []
                });
            }
            setPicked([]);
            setTyped("");
            setProgress(undefined);
            setBusy(false);
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Channels in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">Add one, or clear out several</Text>
                    <Text variant="text-sm/normal">Deleting takes the messages with it and has no undo.</Text>
                </div>

                <Forms.FormTitle tag="h5">Add a channel</Forms.FormTitle>

                <div className={cl("cast-row")}>
                    <TextInput value={name} placeholder="Channel name" onChange={setName} />
                </div>
                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Kind</Text>
                        <Select
                            options={kinds}
                            select={(value: number) => setKind(value)}
                            isSelected={value => value === kind}
                            serialize={String}
                        />
                    </div>
                    {kind !== CATEGORY && (
                        <div className={cl("cast-row")}>
                            <Text variant="text-sm/normal">Category</Text>
                            <Select
                                options={[{ label: "None", value: "" }, ...categories.map(one => ({ label: one.name, value: one.id }))]}
                                select={(value: string) => setParent(value)}
                                isSelected={value => value === parent}
                                serialize={String}
                            />
                        </div>
                    )}
                </div>
                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <TextInput value={topic} placeholder="Topic, optional" onChange={setTopic} />
                    </div>
                    <div className={cl("cast-row")}>
                        <TextInput value={slow} placeholder="Slowmode seconds" onChange={setSlow} />
                    </div>
                </div>
                <div className={cl("chan-switches")}>
                    <FormSwitch hideBorder title="Age restricted" value={nsfw} disabled={busy} onChange={setNsfw} />
                    <FormSwitch hideBorder title="Private" value={priv} disabled={busy} onChange={setPriv} />
                </div>

                {priv && !roles.length && (
                    <Text variant="text-sm/normal" className={cl("empty-state")}>
                        No roles here yet, so only Manage Channels holders will see it.
                    </Text>
                )}

                {priv && roles.length > 0 && (
                    <ScrollerThin className={cl("chan-roles")}>
                        {roles.map(role => (
                            <div key={role.id} className={cl("chan-row")}>
                                <input
                                    type="checkbox"
                                    checked={viewers.includes(role.id)}
                                    disabled={busy}
                                    onChange={() => setViewers(current => current.includes(role.id)
                                        ? current.filter(one => one !== role.id)
                                        : [...current, role.id])}
                                />
                                <div className={cl("safety-title")}>{role.name}</div>
                            </div>
                        ))}
                    </ScrollerThin>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {mayCreate ? "" : "You need Manage Channels in this server"}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button size={Button.Sizes.SMALL} disabled={busy || !mayCreate || !name.trim()} onClick={create}>
                            Create
                        </Button>
                    </div>
                </div>

                {editing && (
                    <ChannelEdit
                        guild={guild}
                        channelId={editing}
                        onClose={() => setEditing(null)}
                    />
                )}

                <Forms.FormTitle tag="h5">Remove channels</Forms.FormTitle>

                <ScrollerThin className={cl("scroller")} orientation="vertical">
                    {ordered.map(({ channel, indented }) => {
                        const allowed = deletable(channel);
                        return (
                            <div
                                key={channel.id}
                                className={cl("chan-row", { "chan-locked": !allowed })}
                                data-indented={indented || undefined}
                                data-category={channel.type === CATEGORY || undefined}
                            >
                                <input
                                    type="checkbox"
                                    checked={picked.includes(channel.id)}
                                    disabled={busy || !allowed}
                                    onChange={() => toggle(channel.id)}
                                />
                                <button
                                    type="button"
                                    className={cl("linkish", "safety-title")}
                                    disabled={busy}
                                    onClick={() => setEditing(editing === channel.id ? null : channel.id)}
                                >
                                    {channel.name}
                                    {channel.type !== CATEGORY && channel.type !== 0 && (
                                        <span className={cl("power-locked")}>{KIND_NAMES[channel.type] ?? channel.type}</span>
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </ScrollerThin>

                {picked.length > TYPE_IT_OUT && (
                    <div className={cl("cast-row")}>
                        <TextInput
                            value={typed}
                            placeholder={`Type ${guild.name} to unlock`}
                            onChange={setTyped}
                        />
                    </div>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (picked.length
                            ? `${plural(picked.length, "channel")} selected, about ${Math.max(1, Math.ceil(picked.length * GAP / 60000))} minute(s)`
                            : "nothing selected")}
                    </Text>

                    <div className={cl("safety-actions-right")}>
                        {busy && progress && (
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => { stop.current = true; }}>
                                Stop
                            </Button>
                        )}
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !picked.length || !confirmed}
                            onClick={() => Alerts.show({
                                title: `Delete ${plural(picked.length, "channel")}?`,
                                body: (
                                    <div>
                                        <p>{picked.map(id => all.find(one => one.id === id)?.name ?? id).join(", ")}</p>
                                        <p><strong>Every message in them goes too, and nothing brings them back.</strong></p>
                                    </div>
                                ),
                                confirmText: "Delete them",
                                confirmColor: Button.Colors.RED,
                                cancelText: "Cancel",
                                onConfirm: remove
                            })}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openChannelsModal(guild: Guild) {
    openModal(props => <Channels guild={guild} modalProps={props} />);
}
