/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { RestAPI, SnowflakeUtils } from "@webpack/common";

import { remember as cached } from "./cache";

const KICK = 20;
const BAN = 22;
const LIMIT = 500;

const key = (guildId: string) => `serverInfo-departures-${guildId}`;

export interface Departure {
    name: string;
    kind: "ban" | "kick";
    at: number;
    by?: string;
}

type Book = Record<string, Departure>;

const loaded = new Map<string, Book>();

async function book(guildId: string): Promise<Book> {
    const cached = loaded.get(guildId);
    if (cached) return cached;

    const stored = await DataStore.get<Book>(key(guildId)) ?? {};
    loaded.set(guildId, stored);
    return stored;
}

async function save(guildId: string, next: Book) {
    const entries = Object.entries(next);
    const trimmed = entries.length <= LIMIT
        ? next
        : Object.fromEntries(entries.sort(([, a], [, b]) => b.at - a.at).slice(0, LIMIT));

    loaded.set(guildId, trimmed);
    await DataStore.set(key(guildId), trimmed);
}

export async function remember(guildId: string, userId: string, entry: Departure) {
    const current = await book(guildId);
    const previous = current[userId];
    if (previous && previous.at >= entry.at) return;

    await save(guildId, { ...current, [userId]: entry });
}

export async function lookUp(guildId: string, userId: string): Promise<Departure | null> {
    return (await book(guildId))[userId] ?? null;
}

export async function everyone(guildId: string): Promise<Book> {
    return { ...await book(guildId) };
}

interface RawEntry {
    id: string;
    user_id: string | null;
    target_id: string | null;
}

interface Response {
    audit_log_entries?: RawEntry[];
    users?: { id: string; username: string; global_name?: string | null; }[];
}

/** the plugin only sees the kicks and bans it made itself, so this reads the ones
 *  everyone else made too. discord keeps 45 days of audit log. */
export async function syncFromAuditLog(guildId: string): Promise<number | "denied"> {
    const found: Book = {};

    for (const action of [KICK, BAN]) {
        let body: Response;
        try {
            body = await cached(`audit:${guildId}:${action}`, async () => (await RestAPI.get({
                url: `/guilds/${guildId}/audit-logs`,
                query: { action_type: String(action), limit: "100" }
            })).body);
        } catch {
            return "denied";
        }

        const names = new Map((body.users ?? []).map(user => [user.id, user.global_name || user.username]));

        for (const entry of body.audit_log_entries ?? []) {
            if (!entry.target_id) continue;

            found[entry.target_id] = {
                name: names.get(entry.target_id) ?? entry.target_id,
                kind: action === BAN ? "ban" : "kick",
                at: SnowflakeUtils.extractTimestamp(entry.id),
                by: (entry.user_id && names.get(entry.user_id)) || undefined
            };
        }
    }

    const current = await book(guildId);
    const merged = { ...current };
    let added = 0;

    for (const [userId, entry] of Object.entries(found)) {
        if (merged[userId] && merged[userId].at >= entry.at) continue;
        merged[userId] = entry;
        added++;
    }

    await save(guildId, merged);
    return added;
}
