/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

const LIMIT = 2000;

const key = (guildId: string) => `serverInfo-arrivals-${guildId}`;

export interface Arrival {
    code: string;
    name: string;
    at: number;
}

export type Arrivals = Record<string, Arrival>;

const loaded = new Map<string, Arrivals>();

export async function arrivals(guildId: string): Promise<Arrivals> {
    const cached = loaded.get(guildId);
    if (cached) return cached;

    const stored = await DataStore.get<Arrivals>(key(guildId)) ?? {};
    loaded.set(guildId, stored);
    return stored;
}

/** discord only reports the invite someone used while they are still a member, so this
 *  keeps a copy. without it a banned account takes the answer with it. */
export async function note(guildId: string, seen: (Arrival & { userId: string; })[]) {
    const current = await arrivals(guildId);
    const next = { ...current };
    let changed = false;

    for (const { userId, code, name, at } of seen) {
        if (next[userId]?.code === code) continue;
        next[userId] = { code, name, at };
        changed = true;
    }

    if (!changed) return;

    const entries = Object.entries(next);
    const trimmed = entries.length <= LIMIT
        ? next
        : Object.fromEntries(entries.sort(([, a], [, b]) => b.at - a.at).slice(0, LIMIT));

    loaded.set(guildId, trimmed);
    await DataStore.set(key(guildId), trimmed);
}
