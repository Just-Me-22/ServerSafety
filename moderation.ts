/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Guild, Permissions } from "@vencord/discord-types";
import { GuildMemberStore, GuildRoleStore, PermissionsBits, RestAPI, UserStore } from "@webpack/common";

import { record, Target } from "./History";
import { guildChannels, has } from "./SafetyTab";

const quarantineKey = (guildId: string) => `serverInfo-quarantine-${guildId}`;

const SILENCE: Permissions[] = [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "SEND_MESSAGES_IN_THREADS",
    "CREATE_PUBLIC_THREADS",
    "CREATE_PRIVATE_THREADS",
    "ADD_REACTIONS",
    "CONNECT",
    "SPEAK"
];

/** everything the current user's roles add up to in this guild */
export function myPermissions(guild: Guild): bigint {
    const me = UserStore.getCurrentUser().id;
    if (guild.ownerId === me) return ~0n;

    const roles = new Map(GuildRoleStore.getSortedRoles(guild.id).map(role => [role.id, role]));
    let permissions = roles.get(guild.id)?.permissions ?? 0n;
    for (const id of GuildMemberStore.getMember(guild.id, me)?.roles ?? []) {
        permissions |= roles.get(id)?.permissions ?? 0n;
    }

    return has(permissions, "ADMINISTRATOR") ? ~0n : permissions;
}

export function topRole(guild: Guild, userId: string): number {
    const roles = new Map(GuildRoleStore.getSortedRoles(guild.id).map(role => [role.id, role]));
    return Math.max(-1, ...(GuildMemberStore.getMember(guild.id, userId)?.roles ?? []).map(id => roles.get(id)?.position ?? -1));
}

/** you can only act on somebody standing below you, and never on the owner */
export function canActOn(guild: Guild, userId: string) {
    const me = UserStore.getCurrentUser().id;
    if (userId === me || userId === guild.ownerId) return false;
    if (guild.ownerId === me) return true;
    return topRole(guild, userId) < topRole(guild, me);
}

export const displayName = (guild: Guild, userId: string) =>
    GuildMemberStore.getMember(guild.id, userId)?.nick
    || UserStore.getUser(userId)?.username
    || userId;

async function log(guild: Guild, what: string, targets: Target[]) {
    await record({ guildId: guild.id, guildName: guild.name, what, targets });
}

export async function timeout(guild: Guild, userId: string, minutes: number) {
    const member = GuildMemberStore.getMember(guild.id, userId);
    const before = (member as any)?.communicationDisabledUntil ?? null;
    const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;

    await RestAPI.patch({
        url: `/guilds/${guild.id}/members/${userId}`,
        body: { communication_disabled_until: until }
    });

    await log(guild, `Timed out ${displayName(guild, userId)} for ${minutes} minutes`, [
        { kind: "timeout", userId, name: displayName(guild, userId), before, after: until }
    ]);
}

export async function kick(guild: Guild, userId: string, reason: string) {
    const name = displayName(guild, userId);
    // Discord's own client takes `reason` and encodes X-Audit-Log-Reason itself,
    // but its published type does not list the field
    await RestAPI.del({ url: `/guilds/${guild.id}/members/${userId}`, reason } as any);

    // a kick cannot be taken back, so it is recorded with nothing to undo
    await log(guild, `Kicked ${name}`, []);
}

export async function ban(guild: Guild, userId: string, reason: string, deleteSeconds: number) {
    const name = displayName(guild, userId);
    await RestAPI.put({
        url: `/guilds/${guild.id}/bans/${userId}`,
        body: { delete_message_seconds: deleteSeconds },
        reason
    } as any);

    await log(guild, `Banned ${name}`, [{ kind: "ban", userId, name }]);
}

export async function warn(guild: Guild, userId: string, text: string) {
    const { body: channel } = await RestAPI.post({
        url: "/users/@me/channels",
        body: { recipient_id: userId }
    });

    const { body: message } = await RestAPI.post({
        url: `/channels/${channel.id}/messages`,
        body: { content: text, allowed_mentions: { parse: [], roles: [], users: [] } }
    });

    await log(guild, `Warned ${displayName(guild, userId)} by DM`, [
        { kind: "message", channelId: channel.id, name: "the DM", messageId: message.id }
    ]);
}

export const savedQuarantineRole = async (guildId: string) =>
    (await DataStore.get<{ roleId: string; }>(quarantineKey(guildId)))?.roleId ?? null;

export const rememberQuarantineRole = (guildId: string, roleId: string) =>
    DataStore.set(quarantineKey(guildId), { roleId });

/** the role itself grants nothing; what silences someone is a deny in every channel,
 *  and Discord resolves deny above any allow the person's other roles hand out */
export async function setupQuarantine(guild: Guild, existingRoleId: string | null, onProgress: (done: number, total: number) => void) {
    let roleId = existingRoleId;

    if (!roleId) {
        const { body: role } = await RestAPI.post({
            url: `/guilds/${guild.id}/roles`,
            body: { name: "Quarantined", permissions: "0", color: 0, hoist: false, mentionable: false }
        });
        roleId = role.id as string;
    }

    let deny = 0n;
    for (const perm of SILENCE) {
        const bit = PermissionsBits[perm];
        if (typeof bit === "bigint") deny |= bit;
    }

    const channels = guildChannels(guild.id);
    for (let i = 0; i < channels.length; i++) {
        await RestAPI.put({
            url: `/channels/${channels[i].id}/permissions/${roleId}`,
            body: { type: 0, allow: "0", deny: String(deny) }
        });
        onProgress(i + 1, channels.length);
    }

    await rememberQuarantineRole(guild.id, roleId);
    return roleId;
}

export async function quarantine(guild: Guild, userId: string, roleId: string) {
    const before = GuildMemberStore.getMember(guild.id, userId)?.roles ?? [];
    if (before.includes(roleId)) return;

    const after = [...before, roleId];
    await RestAPI.patch({ url: `/guilds/${guild.id}/members/${userId}`, body: { roles: after } });

    await log(guild, `Quarantined ${displayName(guild, userId)}`, [
        { kind: "memberRoles", userId, name: displayName(guild, userId), before, after }
    ]);
}

export async function release(guild: Guild, userId: string, roleId: string) {
    const before = GuildMemberStore.getMember(guild.id, userId)?.roles ?? [];
    const after = before.filter(id => id !== roleId);

    await RestAPI.patch({ url: `/guilds/${guild.id}/members/${userId}`, body: { roles: after } });

    await log(guild, `Released ${displayName(guild, userId)} from quarantine`, [
        { kind: "memberRoles", userId, name: displayName(guild, userId), before, after }
    ]);
}

export const isQuarantined = (guild: Guild, userId: string, roleId: string | null) =>
    roleId != null && (GuildMemberStore.getMember(guild.id, userId)?.roles ?? []).includes(roleId);

/** Administrator ignores channel overrides, so quarantine cannot reach them */
export function adminRolesOf(guild: Guild, userId: string) {
    const roles = new Map(GuildRoleStore.getSortedRoles(guild.id).map(role => [role.id, role]));
    return (GuildMemberStore.getMember(guild.id, userId)?.roles ?? [])
        .map(id => roles.get(id))
        .filter(role => role != null && has(role.permissions, "ADMINISTRATOR"));
}
