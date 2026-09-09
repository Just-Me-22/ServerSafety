/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { GuildStore, RestAPI } from "@webpack/common";

import { markUndone, record } from "./History";

const CHECK_EVERY = 60_000;
const LIST_KEY = "serverSafety-lockdowns";

export const panicKey = (guildId: string) => `serverInfo-panic-${guildId}`;

export interface ChannelState {
    id: string;
    name: string;
    allow: string | null;
    deny: string | null;
}

export interface Snapshot {
    at: number;
    entryId?: string;
    verificationLevel: number;
    explicitContentFilter: number;
    invitesDisabledUntil: string | null;
    dmsDisabledUntil: string | null;
    channels: ChannelState[];
    /** when to lift it without being asked. absent means it waits for you. */
    unlockAt?: number;
}

/** the snapshots are keyed per guild, so this is the index of which guilds have one.
 *  without it a sweep would have to guess at keys. */
const locked = async () => (await DataStore.get<string[]>(LIST_KEY)) ?? [];

export async function noteLockdown(guildId: string) {
    const list = await locked();
    if (!list.includes(guildId)) await DataStore.set(LIST_KEY, [...list, guildId]);
}

export async function forgetLockdown(guildId: string) {
    await DataStore.set(LIST_KEY, (await locked()).filter(one => one !== guildId));
}

/** puts back everything the lockdown changed. safe to call when nothing is saved. */
export async function restoreLockdown(guildId: string) {
    const saved = await DataStore.get<Snapshot>(panicKey(guildId));
    if (!saved) {
        await forgetLockdown(guildId);
        return false;
    }

    await RestAPI.patch({
        url: `/guilds/${guildId}`,
        body: {
            verification_level: saved.verificationLevel,
            explicit_content_filter: saved.explicitContentFilter
        }
    });

    await RestAPI.put({
        url: `/guilds/${guildId}/incident-actions`,
        body: {
            invites_disabled_until: saved.invitesDisabledUntil,
            dms_disabled_until: saved.dmsDisabledUntil
        }
    });

    for (const channel of saved.channels) {
        // no override existed before, so writing an empty one would be its own change
        if (channel.allow == null) {
            await RestAPI.del({ url: `/channels/${channel.id}/permissions/${guildId}` });
        } else {
            await RestAPI.put({
                url: `/channels/${channel.id}/permissions/${guildId}`,
                body: { type: 0, allow: channel.allow, deny: channel.deny }
            });
        }
    }

    if (saved.entryId) await markUndone(saved.entryId);
    await DataStore.del(panicKey(guildId));
    await forgetLockdown(guildId);
    return true;
}

async function sweep() {
    for (const guildId of await locked()) {
        const saved = await DataStore.get<Snapshot>(panicKey(guildId));

        if (!saved) {
            await forgetLockdown(guildId);
            continue;
        }

        if (saved.unlockAt == null || saved.unlockAt > Date.now()) continue;

        const name = GuildStore.getGuild(guildId)?.name ?? "a server";

        try {
            await restoreLockdown(guildId);
            await record({
                guildId,
                guildName: name,
                what: "The lockdown ran out and lifted itself",
                targets: []
            });
            showNotification({ title: `${name} is unlocked`, body: "The lockdown ran out and lifted itself." });
        } catch {
            // gone from the server, or the permission is. leave it for the next sweep
        }
    }
}

let timer = 0;

export function startUnlockTimer() {
    void sweep();
    timer = window.setInterval(sweep, CHECK_EVERY);
}

export function stopUnlockTimer() {
    clearInterval(timer);
    timer = 0;
}
