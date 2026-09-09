/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, GuildMemberStore, GuildRoleStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Select, SnowflakeUtils, Text, Toasts, useEffect, useState } from "@webpack/common";

import { forget } from "./cache";
import { confirmBulk } from "./confirm";
import { record } from "./History";
import { fetchInvites } from "./invites";
import { searchMembers } from "./RecentJoins";
import { guildChannels, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const DAY = 86_400_000;
const GAP = 400;
const AGES = [30, 90, 180, 365];

const VOICE = new Set([2, 13]);

interface Row {
    key: string;
    name: string;
    detail: string;
    locked?: string;
}

interface Found {
    roles: Row[];
    channels: Row[];
    invites: Row[];
    checked: number;
    gaps: string[];
}

const ago = (at: number) => {
    const days = Math.floor((Date.now() - at) / DAY);
    if (days < 60) return `${plural(days, "day")} ago`;
    if (days < 730) return `${plural(Math.round(days / 30), "month")} ago`;
    return `${plural(Math.round(days / 365), "year")} ago`;
};

async function look(guild: Guild, olderThan: number): Promise<Found> {
    const gaps: string[] = [];

    const holders = new Map<string, number>();
    const count = (roleIds: string[]) => {
        for (const id of roleIds) holders.set(id, (holders.get(id) ?? 0) + 1);
    };

    for (const member of GuildMemberStore.getMembers(guild.id)) count(member.roles);

    let checked = GuildMemberStore.getMembers(guild.id).length;
    try {
        const raw = await searchMembers(guild.id, 1000);
        checked = Math.max(checked, raw.length);
        for (const entry of raw) count(entry.member.roles ?? []);
    } catch {
        gaps.push("a moderator permission, so only members already loaded were counted");
    }

    const roles: Row[] = GuildRoleStore.getSortedRoles(guild.id)
        .filter(role => role.id !== guild.id && !holders.get(role.id))
        .map(role => ({
            key: role.id,
            name: role.name,
            detail: role.managed ? "nobody holds it, and Discord manages it" : "nobody holds it",
            locked: role.managed ? "Discord manages this one" : undefined
        }));

    const cutoff = Date.now() - olderThan * DAY;
    const channels: Row[] = guildChannels(guild.id)
        .filter(channel => !VOICE.has(channel.type))
        .map(channel => {
            const last = channel.lastMessageId ? SnowflakeUtils.extractTimestamp(channel.lastMessageId) : 0;
            return { channel, last };
        })
        .filter(({ last }) => last < cutoff)
        .sort((a, b) => a.last - b.last)
        .map(({ channel, last }) => ({
            key: channel.id,
            name: `#${channel.name}`,
            detail: last ? `last message ${ago(last)}` : "nothing has ever been posted here"
        }));

    const live = await fetchInvites(guild.id);
    if (!live) gaps.push("Manage Server, so the invites could not be read");

    const invites: Row[] = [...live?.values() ?? []]
        .filter(invite => !invite.uses && invite.code !== guild.vanityURLCode)
        .map(invite => ({
            key: invite.code,
            name: invite.code,
            detail: `nobody used it${invite.inviter ? `, made by ${invite.inviter.global_name || invite.inviter.username}` : ""}${invite.created_at ? `, ${ago(new Date(invite.created_at).getTime())}` : ""}`
        }));

    return { roles, channels, invites, checked, gaps };
}

function Section({ title, rows, ticked, onTick, note }: {
    title: string;
    rows: Row[];
    ticked: Set<string>;
    onTick: (key: string) => void;
    note?: string;
}) {
    if (!rows.length) return <div className={cl("safety-detail")}>{title}: nothing</div>;

    return (
        <>
            <Text variant="text-md/semibold">{title}</Text>
            {note && <div className={cl("safety-detail")}>{note}</div>}
            {rows.map(row => (
                <div key={row.key} className={cl("safety-row")}>
                    <Checkbox
                        value={ticked.has(row.key)}
                        onChange={() => onTick(row.key)}
                        disabled={row.locked != null}
                        align="top"
                    >
                        <div className={cl("safety-title")}>{row.name}</div>
                        <div className={cl("safety-detail")}>{row.locked ?? row.detail}</div>
                    </Checkbox>
                </div>
            ))}
        </>
    );
}

function DeadWeight({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, guild)
        || PermissionStore.can(PermissionsBits.MANAGE_ROLES, guild);

    const [olderThan, setOlderThan] = useState(90);
    const [found, setFound] = useState<Found>();
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    useEffect(() => {
        let alive = true;
        setFound(undefined);
        setTicked(new Set());
        look(guild, olderThan).then(result => { if (alive) setFound(result); });
        return () => { alive = false; };
    }, [guild.id, olderThan]);

    const tick = (key: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    const chosen = found
        ? [
            ...found.roles.filter(row => ticked.has(row.key)).map(row => ({ row, url: `/guilds/${guild.id}/roles/${row.key}` })),
            ...found.channels.filter(row => ticked.has(row.key)).map(row => ({ row, url: `/channels/${row.key}` })),
            ...found.invites.filter(row => ticked.has(row.key)).map(row => ({ row, url: `/invites/${row.key}` }))
        ]
        : [];

    async function remove() {
        setBusy(true);
        let done = 0;

        try {
            for (const { url } of chosen) {
                await RestAPI.del({ url });
                done++;
                setProgress(`deleted ${done} of ${chosen.length}`);
                if (done < chosen.length) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${done}: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            if (done) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Deleted ${plural(done, "thing")} nothing was using. This cannot be undone.`,
                    targets: []
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
            forget(`members:${guild.id}`);
            look(guild, olderThan).then(setFound);
        }
    }

    const total = found ? found.roles.length + found.channels.length + found.invites.length : 0;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Dead weight in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!found
                            ? "Looking..."
                            : total
                                ? `${plural(total, "thing")} nothing is using.`
                                : "Nothing here is going unused."}
                    </Text>
                    {found && found.gaps.length > 0 && (
                        <Text variant="text-sm/normal">You are missing {found.gaps.join(", and ")}.</Text>
                    )}
                    {found && <Text variant="text-sm/normal">Role counts cover {plural(found.checked, "member")}.</Text>}
                </div>

                <div className={cl("cast-row")}>
                    <Text variant="text-sm/normal">Quiet for</Text>
                    <Select
                        options={AGES.map(days => ({ label: `${days} days`, value: days }))}
                        select={(days: number) => setOlderThan(days)}
                        isSelected={value => value === olderThan}
                        serialize={String}
                    />
                </div>

                {found && total > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        <Section title="Roles nobody holds" rows={found.roles} ticked={ticked} onTick={tick} />
                        <Section
                            title="Channels nobody posts in"
                            rows={found.channels}
                            ticked={ticked}
                            onTick={tick}
                            note="Voice channels are left out, they have nothing to measure."
                        />
                        <Section title="Invites nobody used" rows={found.invites} ticked={ticked} onTick={tick} />
                    </ScrollerThin>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (!allowed ? "You need Manage Channels or Manage Roles here" : chosen.length ? `${plural(chosen.length, "thing")} ticked` : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Delete ${plural(chosen.length, "thing")}?`,
                                items: chosen.map(({ row }) => row.name),
                                warning: "Channels take their messages with them, and none of this comes back.",
                                verb: "Delete them",
                                onConfirm: () => void remove()
                            })}
                        >
                            Delete ticked
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openDeadWeightModal(guild: Guild) {
    openModal(props => <DeadWeight guild={guild} modalProps={props} />);
}
