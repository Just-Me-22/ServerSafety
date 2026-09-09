/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Six screens ask Discord for the same thousand members, and four ask for the same
 *  audit log. Opening three of them in a row used to fetch it all three times. */

const LIFE = 60_000;

interface Held<T> {
    at: number;
    value: Promise<T>;
}

const held = new Map<string, Held<any>>();

/** the promise is cached, not the result, so two screens opening at once share one
 *  request rather than racing to make a second */
export function remember<T>(key: string, make: () => Promise<T>, life = LIFE): Promise<T> {
    const now = Date.now();
    const found = held.get(key);
    if (found && now - found.at < life) return found.value;

    const value = make().catch(error => {
        held.delete(key);
        throw error;
    });

    held.set(key, { at: now, value });

    if (held.size > 60) {
        for (const [old, entry] of held) if (now - entry.at > life) held.delete(old);
    }

    return value;
}

/** call after anything that changes what a cached read would return */
export function forget(prefix: string) {
    for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key);
}
