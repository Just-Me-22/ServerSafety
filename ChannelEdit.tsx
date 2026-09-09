/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild } from "@vencord/discord-types";
import { Button, Forms, GuildRoleStore, PermissionsBits, RestAPI, ScrollerThin, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { record } from "./History";

const cl = classNameFactory("vc-ss-");

const CATEGORY = 4;
const SPOILER = 1 << 21;

interface Overwrite {
    id: string;
    type: number;
    allow: string;
    deny: string;
}

interface Raw {
    name: string;
    type: number;
    topic?: string | null;
    nsfw?: boolean;
    flags?: number;
    rate_limit_per_user?: number;
    permission_overwrites?: Overwrite[];
}

const has = (bits: string, bit: bigint) => (BigInt(bits) & bit) !== 0n;
const withBit = (bits: string, bit: bigint, on: boolean) =>
    String(on ? BigInt(bits) | bit : BigInt(bits) & ~bit);

export function ChannelEdit({ guild, channelId, onClose }: { guild: Guild; channelId: string; onClose: () => void; }) {
    const view = PermissionsBits.VIEW_CHANNEL as bigint;
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);

    const [raw, setRaw] = useState<Raw>();
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [slow, setSlow] = useState("");
    const [nsfw, setNsfw] = useState(false);
    const [spoiler, setSpoiler] = useState(false);
    const [priv, setPriv] = useState(false);
    const [viewers, setViewers] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let live = true;
        (async () => {
            const { body } = await RestAPI.get({ url: `/channels/${channelId}` });
            if (!live) return;

            const overwrites: Overwrite[] = body.permission_overwrites ?? [];
            const everyone = overwrites.find(one => one.id === guild.id);

            setRaw(body);
            setName(body.name ?? "");
            setTopic(body.topic ?? "");
            setSlow(body.rate_limit_per_user ? String(body.rate_limit_per_user) : "");
            setNsfw(Boolean(body.nsfw));
            setSpoiler(Boolean((body.flags ?? 0) & SPOILER));
            setPriv(Boolean(everyone && has(everyone.deny, view)));
            setViewers(overwrites.filter(one => one.type === 0 && one.id !== guild.id && has(one.allow, view)).map(one => one.id));
        })();
        return () => { live = false; };
    }, [channelId]);

    function nextOverwrites(): Overwrite[] {
        const current: Overwrite[] = raw?.permission_overwrites ?? [];
        const kept = new Map(current.map(one => [one.id, { ...one }]));

        const everyone = kept.get(guild.id) ?? { id: guild.id, type: 0, allow: "0", deny: "0" };
        everyone.deny = withBit(everyone.deny, view, priv);
        everyone.allow = withBit(everyone.allow, view, false);
        kept.set(guild.id, everyone);

        for (const role of roles) {
            const wanted = viewers.includes(role.id);
            const existing = kept.get(role.id);
            if (!existing && !wanted) continue;

            const entry = existing ?? { id: role.id, type: 0, allow: "0", deny: "0" };
            entry.allow = withBit(entry.allow, view, wanted);
            kept.set(role.id, entry);
        }

        return [...kept.values()].filter(one => one.allow !== "0" || one.deny !== "0");
    }

    async function save() {
        setBusy(true);
        try {
            const seconds = Number(slow);
            const body: Record<string, unknown> = {
                name: name.trim(),
                topic: topic.trim(),
                nsfw,
                flags: spoiler ? (raw?.flags ?? 0) | SPOILER : (raw?.flags ?? 0) & ~SPOILER,
                permission_overwrites: nextOverwrites()
            };
            if (raw?.type !== CATEGORY) {
                body.rate_limit_per_user = Number.isFinite(seconds) && seconds > 0
                    ? Math.min(21600, Math.floor(seconds))
                    : 0;
            }

            await RestAPI.patch({ url: `/channels/${channelId}`, body, reason: "Server Safety: channel edited" } as any);

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Edited ${name.trim()}`,
                targets: []
            });

            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `Saved ${name.trim()}` });
            onClose();
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: error?.body?.message ?? "Could not save that channel"
            });
        } finally {
            setBusy(false);
        }
    }

    if (!raw) return <Text variant="text-sm/normal">Loading…</Text>;

    return (
        <div className={cl("chan-edit")}>
            <Forms.FormTitle tag="h5">Editing {raw.name}</Forms.FormTitle>

            <div className={cl("cast-row")}>
                <TextInput value={name} placeholder="Channel name" onChange={setName} />
            </div>
            <div className={cl("chan-cols")}>
                <div className={cl("cast-row")}>
                    <TextInput value={topic} placeholder="Topic" onChange={setTopic} />
                </div>
                {raw.type !== CATEGORY && (
                    <div className={cl("cast-row")}>
                        <TextInput value={slow} placeholder="Slowmode seconds" onChange={setSlow} />
                    </div>
                )}
            </div>

            <div className={cl("chan-switches")}>
                <FormSwitch hideBorder title="Age restricted" value={nsfw} disabled={busy} onChange={setNsfw} />
                <FormSwitch hideBorder title="Spoiler" value={spoiler} disabled={busy} onChange={setSpoiler} />
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
                <div className={cl("safety-actions-right")}>
                    <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} color={Button.Colors.PRIMARY} disabled={busy} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size={Button.Sizes.SMALL} disabled={busy || !name.trim()} onClick={save}>
                        Save
                    </Button>
                </div>
            </div>
        </div>
    );
}
