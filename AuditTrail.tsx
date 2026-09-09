/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild } from "@vencord/discord-types";
import { ChannelStore, GuildRoleStore, RestAPI, ScrollerThin, SnowflakeUtils, Text, useEffect, useState } from "@webpack/common";

import { remember } from "./cache";
import { list, permNames, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const enum Action {
    GuildUpdate = 1,
    OverwriteCreate = 13,
    OverwriteUpdate = 14,
    OverwriteDelete = 15,
    Kick = 20,
    Ban = 22,
    MemberRoles = 25,
    RoleCreate = 30,
    RoleUpdate = 31,
    RoleDelete = 32
}

const VERIFICATION = ["None", "Low", "Medium", "High", "Highest"];
const FILTER = ["nobody", "members without a role", "everyone"];

interface Change {
    key: string;
    old_value?: any;
    new_value?: any;
}

interface RawEntry {
    id: string;
    user_id: string | null;
    target_id: string | null;
    action_type: number;
    reason?: string;
    changes?: Change[];
    options?: { channel_id?: string; };
}

interface Response {
    audit_log_entries?: RawEntry[];
    users?: { id: string; username: string; global_name?: string | null; }[];
}

export interface TrailEntry {
    id: string;
    who: string;
    whoId: string | null;
    at: number;
    text: string;
    reason?: string;
}

const asBits = (value: unknown) => {
    try {
        return BigInt((value as string | number) ?? 0);
    } catch {
        return 0n;
    }
};

function describe(entry: RawEntry, guild: Guild): string | null {
    const changes = entry.changes ?? [];
    const find = (key: string) => changes.find(change => change.key === key);

    const roleName = (id: string | null) =>
        (id && GuildRoleStore.getRole(guild.id, id)?.name) || find("name")?.old_value || "a role";
    const channelName = (id: string | null | undefined) => {
        const channel = id ? ChannelStore.getChannel(id) : null;
        return channel ? `#${channel.name}` : "a channel";
    };

    switch (entry.action_type) {
        case Action.RoleUpdate: {
            const permissions = find("permissions");
            if (permissions) {
                const before = asBits(permissions.old_value);
                const after = asBits(permissions.new_value);
                const gained = permNames(after & ~before).map(prettyPerm);
                const lost = permNames(before & ~after).map(prettyPerm);
                const parts = [
                    gained.length ? `gave it ${list(gained)}` : "",
                    lost.length ? `took away ${list(lost)}` : ""
                ].filter(Boolean);

                if (parts.length) return `changed ${roleName(entry.target_id)} and ${parts.join(", ")}`;
            }

            const mentionable = find("mentionable");
            if (mentionable) return `made ${roleName(entry.target_id)} ${mentionable.new_value ? "" : "not "}mentionable by anyone`;

            const renamed = find("name");
            if (renamed) return `renamed ${renamed.old_value} to ${renamed.new_value}`;

            return null;
        }

        case Action.RoleCreate:
            return `created the role ${find("name")?.new_value ?? roleName(entry.target_id)}`;

        case Action.RoleDelete:
            return `deleted the role ${find("name")?.old_value ?? "a role"}`;

        case Action.MemberRoles: {
            const added = find("$add")?.new_value as { name: string; }[] | undefined;
            const removed = find("$remove")?.new_value as { name: string; }[] | undefined;
            if (added?.length) return `handed out ${list(added.map(role => role.name))}`;
            if (removed?.length) return `took away ${list(removed.map(role => role.name))}`;
            return null;
        }

        case Action.OverwriteCreate:
        case Action.OverwriteUpdate:
        case Action.OverwriteDelete:
            return `changed who can do what in ${channelName(entry.options?.channel_id ?? entry.target_id)}`;

        case Action.GuildUpdate: {
            const verification = find("verification_level");
            if (verification) return `set the verification level to ${VERIFICATION[verification.new_value] ?? verification.new_value}`;

            const filter = find("explicit_content_filter");
            if (filter) return `set media scanning to ${FILTER[filter.new_value] ?? filter.new_value}`;

            const mfa = find("mfa_level");
            if (mfa) return `${mfa.new_value ? "turned on" : "turned off"} the 2FA requirement for moderators`;

            return null;
        }

        case Action.Ban:
            return "banned someone";

        case Action.Kick:
            return "kicked someone";

        default:
            return null;
    }
}

export async function fetchTrail(guild: Guild): Promise<TrailEntry[] | "denied"> {
    let body: Response;
    try {
        body = await remember(`audit:${guild.id}:all`, async () =>
            (await RestAPI.get({ url: `/guilds/${guild.id}/audit-logs`, query: { limit: "100" } })).body);
    } catch {
        return "denied";
    }

    const names = new Map((body.users ?? []).map(user => [user.id, user.global_name || user.username]));

    return (body.audit_log_entries ?? [])
        .map((entry): TrailEntry | null => {
            const text = describe(entry, guild);
            if (!text) return null;

            return {
                id: entry.id,
                who: (entry.user_id && names.get(entry.user_id)) || "Someone",
                whoId: entry.user_id,
                at: SnowflakeUtils.extractTimestamp(entry.id),
                text,
                reason: entry.reason
            };
        })
        .filter((entry): entry is TrailEntry => entry != null);
}

export function AuditTrail({ guild }: { guild: Guild; }) {
    const [entries, setEntries] = useState<TrailEntry[] | "denied">();

    useEffect(() => {
        let live = true;
        fetchTrail(guild).then(result => { if (live) setEntries(result); });
        return () => { live = false; };
    }, [guild.id]);

    if (!entries) return <Text variant="text-sm/normal">Reading the audit log...</Text>;

    if (entries === "denied") {
        return <Text variant="text-sm/normal">You need View Audit Log in this server to see who changed things.</Text>;
    }

    if (!entries.length) {
        return <Text variant="text-sm/normal">Nothing in the last 100 audit log entries touched permissions or safety settings.</Text>;
    }

    return (
        <ScrollerThin className={cl("trail")} orientation="vertical">
            {entries.map(entry => (
                <div key={entry.id} className={cl("trail-row")}>
                    <div className={cl("trail-text")}>
                        <span className={cl("trail-who")}>{entry.who}</span> {entry.text}
                    </div>
                    <div className={cl("trail-when")}>
                        {new Date(entry.at).toLocaleString()}
                        {entry.reason && `, because: ${entry.reason}`}
                    </div>
                </div>
            ))}
        </ScrollerThin>
    );
}
