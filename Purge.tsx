/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Select, Text, TextInput, Toasts, useRef, useState } from "@webpack/common";

import { sendableChannels } from "./Broadcast";
import { confirmBulk } from "./confirm";
import { record } from "./History";
import { plural } from "./SafetyTab";
import { settings } from "./settings";

const cl = classNameFactory("vc-ss-");

const scanDepth = (cap: number) => Math.max(600, cap * 6);
const GAP = 1100;

interface Msg {
    id: string;
    content: string;
    pinned: boolean;
    timestamp: string;
    author: { id: string; username: string; global_name?: string | null; bot?: boolean; };
    attachments: unknown[];
}

const LINK = /https?:\/\/|discord\.gg\//i;

function Purge({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const channels = sendableChannels(guild);
    const CAP = settings.store.purgeCap;
    const SCAN = scanDepth(CAP);

    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
    const [from, setFrom] = useState("");
    const [prefix, setPrefix] = useState("");
    const [contains, setContains] = useState("");
    const [botsOnly, setBotsOnly] = useState(false);
    const [withFiles, setWithFiles] = useState(false);
    const [withLinks, setWithLinks] = useState(false);
    const [includePinned, setIncludePinned] = useState(false);

    const [found, setFound] = useState<Msg[]>();
    const [keep, setKeep] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();
    // a ref rather than state: the loop below captures its variables when it starts, so
    // a state update from the stop button would never be visible to a run in progress
    const stop = useRef(false);

    const channel = channels.find(c => c.id === channelId);
    const allowed = channel != null && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);

    const matches = (m: Msg) => {
        if (!includePinned && m.pinned) return false;
        if (from.trim() && m.author.id !== from.trim()) return false;
        if (botsOnly && !m.author.bot) return false;
        if (prefix.trim() && !m.content.startsWith(prefix.trim())) return false;
        if (contains.trim() && !m.content.toLowerCase().includes(contains.trim().toLowerCase())) return false;
        if (withFiles && !m.attachments.length) return false;
        if (withLinks && !LINK.test(m.content)) return false;
        return true;
    };

    const chosen = found?.filter(m => !keep.has(m.id)) ?? [];

    const spare = (id: string) => setKeep(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    async function scan() {
        setBusy(true);
        setFound(undefined);
        setKeep(new Set());
        try {
            const hits: Msg[] = [];
            let before: string | undefined;
            let seen = 0;

            while (seen < SCAN && hits.length < CAP) {
                const { body } = await RestAPI.get({
                    url: `/channels/${channelId}/messages`,
                    query: before ? { limit: "100", before } : { limit: "100" }
                });

                const page = body as Msg[];
                if (!page.length) break;

                seen += page.length;
                before = page[page.length - 1].id;

                for (const m of page) {
                    if (hits.length >= CAP) break;
                    if (matches(m)) hits.push(m);
                }
                setProgress(`read ${seen}, matched ${hits.length}`);
            }

            setFound(hits);
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setProgress(undefined);
            setBusy(false);
        }
    }

    async function purge() {
        if (!chosen.length) return;
        setBusy(true);
        stop.current = false;

        let done = 0;
        try {
            for (const m of chosen) {
                if (stop.current) break;

                await RestAPI.del({ url: `/channels/${channelId}/messages/${m.id}` });
                done++;
                setProgress(`deleted ${done} of ${chosen.length}`);

                if (done < chosen.length) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${done}: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            if (done) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Deleted ${plural(done, "message")} in #${channel?.name}. This cannot be undone.`,
                    targets: []
                });
            }
            setProgress(undefined);
            setFound(undefined);
            setKeep(new Set());
            setBusy(false);
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `Deleted ${done}` });
        }
    }

    const filtered = [from, prefix, contains].some(f => f.trim()) || botsOnly || withFiles || withLinks;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Clear messages in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        Up to {CAP} at a time, about {Math.ceil(CAP * GAP / 60000)} minutes for a full run.
                    </Text>
                    <Text variant="text-sm/normal">
                        A user account has no bulk delete, so this removes them one at a time and paces
                        itself to stay under the rate limit. Nothing here can be undone, so check the
                        preview before you start.
                    </Text>
                </div>

                <div className={cl("cast-row")}>
                    <Text variant="text-sm/normal">Channel</Text>
                    <Select
                        options={channels.map(c => ({ label: `#${c.name}`, value: c.id }))}
                        select={(id: string) => { setChannelId(id); setFound(undefined); setKeep(new Set()); }}
                        isSelected={value => value === channelId}
                        serialize={String}
                    />
                </div>

                <div className={cl("cast-row")}>
                    <TextInput value={from} placeholder="Only from this user id, optional" onChange={setFrom} />
                </div>
                <div className={cl("cast-row")}>
                    <TextInput value={prefix} placeholder="Only messages starting with, optional" onChange={setPrefix} />
                </div>
                <div className={cl("cast-row")}>
                    <TextInput value={contains} placeholder="Only messages containing, optional" onChange={setContains} />
                </div>

                <FormSwitch hideBorder title="Only bots" value={botsOnly} disabled={busy} onChange={setBotsOnly} />
                <FormSwitch hideBorder title="Only messages with an attachment" value={withFiles} disabled={busy} onChange={setWithFiles} />
                <FormSwitch hideBorder title="Only messages with a link" value={withLinks} disabled={busy} onChange={setWithLinks} />
                <FormSwitch
                    hideBorder
                    title="Include pinned messages"
                    value={includePinned}
                    disabled={busy}
                    onChange={setIncludePinned}
                />

                {found && found.length > 0 && (
                    <>
                        <div className={cl("purge-pick")}>
                            <Text variant="text-sm/normal">
                                {chosen.length} of {found.length} ticked
                            </Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy || !keep.size}
                                    onClick={() => setKeep(new Set())}
                                >
                                    Tick all
                                </Button>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy || !chosen.length}
                                    onClick={() => setKeep(new Set(found.map(m => m.id)))}
                                >
                                    Untick all
                                </Button>
                            </div>
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {found.map(m => (
                                <div key={m.id} className={cl("safety-row")}>
                                    <Checkbox
                                        value={!keep.has(m.id)}
                                        onChange={() => spare(m.id)}
                                        disabled={busy}
                                        align="top"
                                    >
                                        <div className={cl("safety-title")}>
                                            {m.author.global_name || m.author.username}
                                            {m.author.bot && <span className={cl("power-locked")}>bot</span>}
                                        </div>
                                        <div className={cl("safety-detail")}>
                                            {new Date(m.timestamp).toLocaleString()}
                                            {m.content ? `  ${m.content.slice(0, 140)}` : "  (no text, an attachment or embed)"}
                                        </div>
                                    </Checkbox>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (!allowed
                                ? "You need Manage Messages in that channel"
                                : found
                                    ? found.length
                                        ? chosen.length
                                            ? `${plural(chosen.length, "message")} ticked, about ${Math.ceil(chosen.length * GAP / 60000)} minute(s) to clear`
                                            : "nothing ticked"
                                        : "nothing matches those filters"
                                    : filtered ? "ready to look" : "no filters set, so this would match everything it reads")}
                    </Text>

                    <div className={cl("safety-actions-right")}>
                        {busy && progress?.startsWith("deleted") && (
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => { stop.current = true; }}>
                                Stop
                            </Button>
                        )}
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} disabled={busy || !allowed} onClick={scan}>
                            {found ? "Look again" : "Find them"}
                        </Button>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Delete ${plural(chosen.length, "message")}?`,
                                items: chosen.map(one => `${one.author.global_name || one.author.username}: ${(one.content || "an attachment").slice(0, 60)}`),
                                warning: `From #${channel?.name}, about ${Math.ceil(chosen.length * GAP / 60000)} minute(s). Nothing brings them back.`,
                                verb: "Delete them",
                                onConfirm: purge
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

export function openPurgeModal(guild: Guild) {
    openModal(props => <Purge guild={guild} modalProps={props} />);
}
