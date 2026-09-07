/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI } from "@webpack/common";

export interface Invite {
    code: string;
    uses: number;
    max_uses: number;
    max_age: number;
    temporary: boolean;
    created_at?: string;
    expires_at?: string | null;
    channel?: { id: string; name: string; } | null;
    inviter?: { id: string; username: string; global_name?: string | null; } | null;
}

/** null when you lack Manage Server, which is not the same as there being none */
export async function fetchInvites(guildId: string): Promise<Map<string, Invite> | null> {
    try {
        const { body } = await RestAPI.get({ url: `/guilds/${guildId}/invites` });
        return new Map((body as Invite[]).map(invite => [invite.code, invite]));
    } catch {
        return null;
    }
}

export function describeInvite(invite: Invite) {
    const lines: string[] = [];

    const who = invite.inviter?.global_name || invite.inviter?.username;
    lines.push(who ? `Made by ${who}` : "Made by nobody the server remembers");

    if (invite.channel) lines.push(`Points at #${invite.channel.name}`);

    lines.push(invite.max_uses
        ? `Used ${invite.uses} of ${invite.max_uses} times`
        : `Used ${invite.uses} times, with no limit`);

    if (invite.created_at) lines.push(`Made on ${new Date(invite.created_at).toLocaleString()}`);

    lines.push(invite.expires_at
        ? `Expires ${new Date(invite.expires_at).toLocaleString()}`
        : "Never expires");

    if (invite.temporary) lines.push("Membership is temporary, so people are dropped when they go offline");

    return lines;
}
