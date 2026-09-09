/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Forms, Modal, openModal, RestAPI, ScrollerThin, SnowflakeUtils, Text, useEffect, useState } from "@webpack/common";

import { note } from "./arrivals";
import { remember } from "./cache";
import { Departure, everyone, syncFromAuditLog } from "./departures";
import { describeInvite, fetchInvites, Invite } from "./invites";
import { openMemberPowerModal } from "./MemberPower";
import { canModerate, openPunishModal } from "./Punish";
import { list, plural } from "./SafetyTab";
import { settings } from "./settings";

const cl = classNameFactory("vc-ss-");

const NEWEST_FIRST = 1;
const DAY = 86_400_000;
const BURST_WINDOW = 60_000;
const BURST_SIZE = 3;

export interface RawMember {
    member: {
        user: { id: string; username: string; global_name?: string | null; avatar?: string | null; };
        nick?: string | null;
        roles?: string[];
        joined_at: string;
        communication_disabled_until?: string | null;
        unusual_dm_activity_until?: string | null;
    };
    source_invite_code?: string | null;
    inviter_id?: string | null;
    unusual_account_activity?: boolean;
    automod_quarantined_username?: boolean;
}

interface Row {
    id: string;
    name: string;
    avatar: string | null;
    joinedAt: number;
    accountAge: number;
    invite: string | null;
    flags: string[];
}

export const searchMembers = (guildId: string, limit: number) =>
    remember(`members:${guildId}:${limit}`, () => fetchMembers(guildId, limit));

async function fetchMembers(guildId: string, limit: number, attempt = 0): Promise<RawMember[]> {
    const response = await RestAPI.post({
        url: `/guilds/${guildId}/members-search`,
        body: { limit: Math.min(Math.max(limit, 1), 1000), sort: NEWEST_FIRST }
    });

    // discord answers 202 while it builds the index, and asks to be asked again
    if (response.status === 202 && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, (response.body?.retry_after ?? 1) * 1000));
        return fetchMembers(guildId, limit, attempt + 1);
    }

    return response.body?.members ?? [];
}

export const arrivalsIn = (raw: RawMember[]) => raw
    .filter(entry => entry.source_invite_code)
    .map(entry => ({
        userId: entry.member.user.id,
        code: entry.source_invite_code!,
        name: entry.member.user.global_name || entry.member.user.username,
        at: new Date(entry.member.joined_at).getTime()
    }));

const stem = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");

function toRows(raw: RawMember[]): Row[] {
    const rows = raw.map(entry => {
        const { user } = entry.member;
        const joinedAt = new Date(entry.member.joined_at).getTime();

        const flags: string[] = [];
        if (entry.unusual_account_activity) flags.push("Discord flagged this account");
        if (entry.automod_quarantined_username) flags.push("AutoMod quarantined the name");
        if (entry.member.communication_disabled_until && new Date(entry.member.communication_disabled_until) > new Date()) flags.push("currently timed out");
        if (entry.member.unusual_dm_activity_until) flags.push("unusual DM activity");
        if (!user.avatar) flags.push("no avatar");

        return {
            id: user.id,
            name: user.global_name || user.username,
            avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
            joinedAt,
            accountAge: joinedAt - SnowflakeUtils.extractTimestamp(user.id),
            invite: entry.source_invite_code ?? null,
            flags
        };
    });

    for (const row of rows) {
        if (Date.now() - SnowflakeUtils.extractTimestamp(row.id) < DAY) row.flags.push("account made today");
    }

    const byStem = new Map<string, Row[]>();
    for (const row of rows) {
        const key = stem(row.name);
        if (key.length < 3) continue;
        byStem.set(key, [...(byStem.get(key) ?? []), row]);
    }
    for (const group of byStem.values()) {
        if (group.length > 1) for (const row of group) row.flags.push(`name matches ${group.length - 1} other`);
    }

    const times = rows.map(row => row.joinedAt).sort((a, b) => a - b);
    for (const row of rows) {
        const near = times.filter(time => Math.abs(time - row.joinedAt) < BURST_WINDOW).length;
        if (near >= BURST_SIZE) row.flags.push(`arrived with ${near - 1} others`);
    }

    return rows;
}

const ago = (ms: number) => {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return plural(Math.max(minutes, 1), "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 48) return plural(hours, "hour");
    return plural(Math.round(hours / 24), "day");
};

function RecentJoins({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const moderator = canModerate(guild);
    const [rows, setRows] = useState<Row[]>();
    const [denied, setDenied] = useState(false);
    const [onlyFlagged, setOnlyFlagged] = useState(false);
    const [invites, setInvites] = useState<Map<string, Invite> | null>();
    const [past, setPast] = useState<Record<string, Departure>>();
    const [open, setOpen] = useState<string>();

    useEffect(() => {
        let live = true;
        searchMembers(guild.id, settings.store.joinsCount)
            .then(raw => {
                void note(guild.id, arrivalsIn(raw));
                if (live) setRows(toRows(raw));
            })
            .catch(() => { if (live) setDenied(true); });
        fetchInvites(guild.id).then(found => { if (live) setInvites(found); });
        syncFromAuditLog(guild.id)
            .then(() => everyone(guild.id))
            .then(book => { if (live) setPast(book); });
        return () => { live = false; };
    }, [guild.id]);

    const sharedWith = (code: string) => (rows ?? []).filter(row => row.invite === code).length;

    // a record older than this stay means they left and came back. one from after it
    // would be about the stay they are on now, which is not a rejoin.
    const rejoined = (row: Row) => {
        const before = past?.[row.id];
        if (!before || before.at >= row.joinedAt) return null;
        return `${before.kind === "ban" ? "banned" : "kicked"} here on ${new Date(before.at).toLocaleDateString()}${before.by ? ` by ${before.by}` : ""}, and came back`;
    };

    const withPast = (rows ?? []).map(row => {
        const back = rejoined(row);
        return back ? { ...row, flags: [back, ...row.flags] } : row;
    });

    const flagged = withPast.filter(row => row.flags.length);
    const shown = onlyFlagged ? flagged : withPast;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Who just joined {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied
                            ? "You need one of Ban, Kick, Timeout, Manage Roles or Manage Nicknames here."
                            : !rows
                                ? "Asking Discord..."
                                : `The last ${plural(rows.length, "person")} to join. ${flagged.length} carry a flag.`}
                    </Text>
                    <Text variant="text-sm/normal">A flag is worth a look, not a ban. Several on one person, or the same flag across several people, is the signal.</Text>
                </div>

                {rows && rows.length > 0 && (
                    <>
                        <FormSwitch
                            hideBorder
                            title="Only the ones with a flag"
                            value={onlyFlagged}
                            onChange={setOnlyFlagged}
                        />

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {shown.map(row => (
                                <div key={row.id} className={cl("joins-row", { critical: row.flags.length > 1 })}>
                                    {row.avatar
                                        ? <img className={cl("servers-icon")} src={row.avatar} alt="" />
                                        : <div className={cl("servers-icon", "servers-icon-empty")} aria-hidden />}

                                    <div className={cl("joins-body")}>
                                        <button
                                            type="button"
                                            className={cl("linkish", "safety-title")}
                                            onClick={() => openUserProfile(row.id, guild.id)}
                                        >
                                            {row.name}
                                        </button>
                                        <div className={cl("safety-detail")}>
                                            Joined {ago(Date.now() - row.joinedAt)} ago, account was {ago(row.accountAge)} old by then
                                            {row.invite && (
                                                <>
                                                    , through{" "}
                                                    <button
                                                        type="button"
                                                        className={cl("linkish", "joins-invite")}
                                                        aria-expanded={open === row.id}
                                                        onClick={() => setOpen(open === row.id ? undefined : row.id)}
                                                    >
                                                        {row.invite}
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {open === row.id && row.invite && (
                                            <div className={cl("joins-detail")}>
                                                {row.invite === guild.vanityURLCode
                                                    ? <div>This is the server's vanity URL, so it is public and permanent.</div>
                                                    : invites === undefined
                                                        ? <div>Looking it up...</div>
                                                        : invites === null
                                                            ? <div>You need Manage Server to see who made this invite.</div>
                                                            : invites.get(row.invite)
                                                                ? describeInvite(invites.get(row.invite)!).map(line => <div key={line}>{line}</div>)
                                                                : <div>That invite has been deleted since, so there is nothing left to read.</div>}
                                                {sharedWith(row.invite) > 1 && (
                                                    <div className={cl("joins-flags")}>
                                                        {sharedWith(row.invite)} of the people listed here came in through this one code.
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {row.flags.length > 0 && <div className={cl("joins-flags")}>{list(row.flags)}</div>}
                                    </div>

                                    <div className={cl("safety-row-actions")}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            onClick={() => openMemberPowerModal(guild, row.id)}
                                        >
                                            Look at them
                                        </Button>
                                        {moderator && (
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                look={Button.Looks.LINK}
                                                onClick={() => openPunishModal(guild, row.id)}
                                            >
                                                Act on them
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openRecentJoinsModal(guild: Guild) {
    openModal(props => <RecentJoins guild={guild} modalProps={props} />);
}
