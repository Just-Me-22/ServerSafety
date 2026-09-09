/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildMemberStore, GuildRoleStore, GuildStore, RestAPI } from "@webpack/common";

const KEY = "serverInfo-history";
const PER_GUILD = 100;
const TOTAL = 600;

interface Overwrite {
    allow: string;
    deny: string;
}

interface GuildSettings {
    verification_level: number;
    explicit_content_filter: number;
    features?: string[];
    rules_channel_id?: string | null;
    public_updates_channel_id?: string | null;
    default_message_notifications?: number;
}

interface Incidents {
    invites_disabled_until: string | null;
    dms_disabled_until: string | null;
}

export type Target =
    | { kind: "role"; roleId: string; name: string; before: string; after: string; }
    | { kind: "memberRoles"; userId: string; name: string; before: string[]; after: string[]; }
    | { kind: "guild"; before: GuildSettings; after: GuildSettings; }
    | { kind: "incidents"; before: Incidents; after: Incidents; }
    | { kind: "overwrite"; channelId: string; name: string; before: Overwrite | null; after: Overwrite | null; }
    | { kind: "message"; channelId: string; name: string; messageId: string; }
    | { kind: "ban"; userId: string; name: string; }
    | { kind: "kick"; userId: string; name: string; }
    | { kind: "nick"; userId: string; name: string; before: string | null; after: string | null; }
    | { kind: "timeout"; userId: string; name: string; before: string | null; after: string | null; }
    | { kind: "slowmode"; channelId: string; name: string; before: number; after: number; };

export interface Entry {
    id: string;
    at: number;
    guildId: string;
    guildName: string;
    what: string;
    targets: Target[];
    undoneAt?: number;
}

export async function readHistory(): Promise<Entry[]> {
    return await DataStore.get<Entry[]>(KEY) ?? [];
}

export async function record(entry: Omit<Entry, "id" | "at">) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const log = await readHistory();

    log.unshift({ ...entry, id, at: Date.now() });

    const kept = new Map<string, number>();
    const trimmed = log.filter(one => {
        const seen = (kept.get(one.guildId) ?? 0) + 1;
        kept.set(one.guildId, seen);
        return seen <= PER_GUILD;
    });

    await DataStore.set(KEY, trimmed.slice(0, TOTAL));

    return id;
}

export async function markUndone(id: string) {
    const log = await readHistory();
    const entry = log.find(item => item.id === id);
    if (!entry) return;

    entry.undoneAt = Date.now();
    await DataStore.set(KEY, log);
}

export async function clearHistory() {
    await DataStore.set(KEY, []);
}

const sameOverwrite = (a: Overwrite | null, b: Overwrite | null) =>
    a == null || b == null ? a === b : a.allow === b.allow && a.deny === b.deny;

function currentOverwrite(channelId: string, guildId: string): Overwrite | null {
    const overwrite = ChannelStore.getChannel(channelId)?.permissionOverwrites?.[guildId];
    return overwrite ? { allow: String(overwrite.allow), deny: String(overwrite.deny) } : null;
}

export function drifted(entry: Entry): string[] {
    const guild = GuildStore.getGuild(entry.guildId);
    if (!guild) return ["the server itself, which you are no longer in"];

    const off: string[] = [];

    for (const target of entry.targets) {
        switch (target.kind) {
            case "role": {
                const now = GuildRoleStore.getRole(entry.guildId, target.roleId);
                if (!now) off.push(`${target.name}, which no longer exists`);
                else if (String(now.permissions) !== target.after) off.push(target.name);
                break;
            }
            case "memberRoles": {
                const now = GuildMemberStore.getMember(entry.guildId, target.userId)?.roles;
                if (!now) off.push(`${target.name}, who has left`);
                else if ([...now].sort().join() !== [...target.after].sort().join()) off.push(target.name);
                break;
            }
            case "guild": {
                if (guild.verificationLevel !== target.after.verification_level
                    || guild.explicitContentFilter !== target.after.explicit_content_filter) off.push("the server's safety settings");
                break;
            }
            case "incidents": {
                const now = (guild as any).incidentsData ?? {};
                if ((now.invitesDisabledUntil ?? null) !== target.after.invites_disabled_until
                    || (now.dmsDisabledUntil ?? null) !== target.after.dms_disabled_until) off.push("the invite and DM pause");
                break;
            }
            case "overwrite": {
                if (!ChannelStore.getChannel(target.channelId)) off.push(`#${target.name}, which no longer exists`);
                else if (!sameOverwrite(currentOverwrite(target.channelId, entry.guildId), target.after)) off.push(`#${target.name}`);
                break;
            }
            case "message":
            case "ban":
            case "kick":
                break;
            case "timeout": {
                const now = (GuildMemberStore.getMember(entry.guildId, target.userId) as any)?.communicationDisabledUntil ?? null;
                if (now !== target.after) off.push(target.name);
                break;
            }
            case "nick": {
                const member = GuildMemberStore.getMember(entry.guildId, target.userId);
                if (!member) off.push(`${target.name}, who has left`);
                else if ((member.nick ?? null) !== target.after) off.push(target.name);
                break;
            }
            case "slowmode": {
                const channel = ChannelStore.getChannel(target.channelId);
                if (!channel) off.push(`#${target.name}, which no longer exists`);
                else if (channel.rateLimitPerUser !== target.after) off.push(`#${target.name}`);
                break;
            }
        }
    }

    return off;
}

export async function undo(entry: Entry) {
    for (const target of entry.targets) {
        switch (target.kind) {
            case "role":
                await RestAPI.patch({
                    url: `/guilds/${entry.guildId}/roles/${target.roleId}`,
                    body: { permissions: target.before }
                });
                break;

            case "memberRoles":
                await RestAPI.patch({
                    url: `/guilds/${entry.guildId}/members/${target.userId}`,
                    body: { roles: target.before.filter(id => GuildRoleStore.getRole(entry.guildId, id) != null) }
                });
                break;

            case "guild":
                await RestAPI.patch({ url: `/guilds/${entry.guildId}`, body: target.before });
                break;

            case "incidents":
                await RestAPI.put({ url: `/guilds/${entry.guildId}/incident-actions`, body: target.before });
                break;

            case "overwrite":
                // no override existed before, so writing an empty one would be its own change
                if (target.before == null) {
                    await RestAPI.del({ url: `/channels/${target.channelId}/permissions/${entry.guildId}` });
                } else {
                    await RestAPI.put({
                        url: `/channels/${target.channelId}/permissions/${entry.guildId}`,
                        body: { type: 0, allow: target.before.allow, deny: target.before.deny }
                    });
                }
                break;

            case "message":
                try {
                    await RestAPI.del({ url: `/channels/${target.channelId}/messages/${target.messageId}` });
                } catch {
                }
                break;

            case "ban":
                try {
                    await RestAPI.del({ url: `/guilds/${entry.guildId}/bans/${target.userId}` });
                } catch {
                }
                break;

            // nothing to put back: they can rejoin on their own with any working invite
            case "kick":
                break;

            case "timeout":
                await RestAPI.patch({
                    url: `/guilds/${entry.guildId}/members/${target.userId}`,
                    body: { communication_disabled_until: target.before }
                });
                break;

            case "slowmode":
                await RestAPI.patch({
                    url: `/channels/${target.channelId}`,
                    body: { rate_limit_per_user: target.before }
                });
                break;

            case "nick":
                await RestAPI.patch({
                    url: `/guilds/${entry.guildId}/members/${target.userId}`,
                    body: { nick: target.before }
                });
                break;
        }
    }

    await markUndone(entry.id);
}
