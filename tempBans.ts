/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { RestAPI } from "@webpack/common";

import { record } from "./History";

const KEY = "serverSafety-tempBans";
const CHECK_EVERY = 5 * 60_000;

export interface TempBan {
    guildId: string;
    guildName: string;
    userId: string;
    name: string;
    until: number;
}

const load = async () => (await DataStore.get<TempBan[]>(KEY)) ?? [];
const save = (bans: TempBan[]) => DataStore.set(KEY, bans);

export const pendingUnbans = load;

export async function scheduleUnban(entry: TempBan) {
    const rest = (await load()).filter(b => b.guildId !== entry.guildId || b.userId !== entry.userId);
    await save([...rest, entry]);
}

export async function cancelUnban(guildId: string, userId: string) {
    await save((await load()).filter(b => b.guildId !== guildId || b.userId !== userId));
}

async function sweep() {
    const pending = await load();
    const due = pending.filter(b => b.until <= Date.now());
    if (!due.length) return;

    for (const entry of due) {
        try {
            await RestAPI.del({ url: `/guilds/${entry.guildId}/bans/${entry.userId}` });
            await record({
                guildId: entry.guildId,
                guildName: entry.guildName,
                what: `Ban on ${entry.name} ran out, lifted it`,
                targets: []
            });
        } catch {
            // lifted by hand already, or the permission is gone. either way stop tracking it
        }
    }

    await save(pending.filter(b => b.until > Date.now()));
}

let timer = 0;

export function startTempBans() {
    void sweep();
    timer = window.setInterval(sweep, CHECK_EVERY);
}

export function stopTempBans() {
    clearInterval(timer);
    timer = 0;
}
