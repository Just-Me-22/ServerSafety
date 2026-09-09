/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildStore, PermissionsBits, PermissionStore, RestAPI } from "@webpack/common";

import { record } from "./History";

const KEY = "serverSafety-autoSlow";
const CONFIG_KEY = "serverSafety-autoSlow-config";
const QUIET_KEY = "serverSafety-quietHours-config";
const CHECK_EVERY = 60_000;

interface Held {
    guildId: string;
    guildName: string;
    channelId: string;
    name: string;
    before: number;
    after: number;
    /** when a flood hold expires. quiet hours holds sit on 0 and end with the window. */
    until: number;
    why: "flood" | "quiet";
}

export interface QuietConfig {
    on: boolean;
    /** hours of the day, 0 to 23. from above to wraps midnight. */
    from: number;
    to: number;
    seconds: number;
    channelIds: string[];
}

const QUIET_OFF: QuietConfig = { on: false, from: 23, to: 7, seconds: 15, channelIds: [] };

let quiet: Record<string, QuietConfig> = {};

export const quietConfigFor = (guildId: string): QuietConfig => quiet[guildId] ?? QUIET_OFF;

export async function setQuietConfig(guildId: string, next: QuietConfig) {
    quiet = { ...quiet, [guildId]: next };
    await DataStore.set(QUIET_KEY, quiet);
    await quietSweep();
}

/** from 23 to 7 means the window runs over midnight, so it is two ranges, not one */
export const inWindow = (hour: number, from: number, to: number) =>
    from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;

export interface SlowConfig {
    on: boolean;
    /** how many messages inside the window counts as flooding */
    count: number;
    /** the window itself, in seconds */
    window: number;
    /** the slowmode to put the channel on */
    seconds: number;
    /** how long to hold it there */
    minutes: number;
}

const OFF: SlowConfig = { on: false, count: 25, window: 10, seconds: 5, minutes: 10 };

/** kept in memory as well as on disk: the message handler runs on every message and
 *  cannot wait on a read */
let configs: Record<string, SlowConfig> = {};

export const configFor = (guildId: string): SlowConfig => configs[guildId] ?? OFF;

export async function setConfig(guildId: string, next: SlowConfig) {
    configs = { ...configs, [guildId]: next };
    await DataStore.set(CONFIG_KEY, configs);
}

const load = async () => (await DataStore.get<Held[]>(KEY)) ?? [];
const save = (held: Held[]) => DataStore.set(KEY, held);

export const pendingSlowmode = load;

/** already holding this channel, so a second spike does not stack another timer or
 *  record the raised value as the one to put back */
async function holding(channelId: string) {
    return (await load()).some(one => one.channelId === channelId);
}

export async function slowDown(guildId: string, guildName: string, channelId: string, seconds: number, minutes: number) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    if (!PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel)) return;
    if (await holding(channelId)) return;

    const before = (channel as any).rateLimitPerUser ?? 0;
    if (before >= seconds) return;

    await RestAPI.patch({
        url: `/channels/${channelId}`,
        body: { rate_limit_per_user: seconds },
        reason: "Server Safety: channel was flooding"
    } as any);

    const entry: Held = {
        guildId,
        guildName,
        channelId,
        name: channel.name,
        before,
        after: seconds,
        until: Date.now() + minutes * 60_000,
        why: "flood"
    };

    await save([...(await load()), entry]);

    await record({
        guildId,
        guildName,
        what: `#${channel.name} was flooding, put it on ${seconds}s slowmode`,
        targets: [{ kind: "slowmode", channelId, name: channel.name, before, after: seconds }]
    });
}

/** puts the chosen channels on slowmode while the window is open and takes it off when
 *  it closes. a channel already held for flooding is left alone: that hold knows the
 *  real earlier value and this one would record the raised one. */
async function quietSweep() {
    const hour = new Date().getHours();
    const held = await load();
    let next = held;

    for (const [guildId, config] of Object.entries(quiet)) {
        const open = config.on && inWindow(hour, config.from, config.to);
        const guild = GuildStore.getGuild(guildId);
        if (!guild) continue;

        for (const channelId of config.channelIds) {
            const mine = next.find(one => one.channelId === channelId && one.why === "quiet");

            if (open && !mine && !next.some(one => one.channelId === channelId)) {
                const channel = ChannelStore.getChannel(channelId);
                if (!channel || !PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel)) continue;

                const before = (channel as any).rateLimitPerUser ?? 0;
                if (before >= config.seconds) continue;

                try {
                    await RestAPI.patch({
                        url: `/channels/${channelId}`,
                        body: { rate_limit_per_user: config.seconds },
                        reason: "Server Safety: quiet hours"
                    } as any);
                } catch {
                    continue;
                }

                next = [...next, {
                    guildId, guildName: guild.name, channelId, name: channel.name,
                    before, after: config.seconds, until: 0, why: "quiet"
                }];
            }

            if (!open && mine) {
                try {
                    await RestAPI.patch({
                        url: `/channels/${channelId}`,
                        body: { rate_limit_per_user: mine.before },
                        reason: "Server Safety: quiet hours are over"
                    } as any);
                } catch {
                    // channel or permission gone, drop the hold either way
                }
                next = next.filter(one => one !== mine);
            }
        }
    }

    if (next !== held) await save(next);
}

async function sweep() {
    await quietSweep();

    const held = await load();
    const due = held.filter(one => one.why === "flood" && one.until <= Date.now());
    if (!due.length) return;

    for (const entry of due) {
        try {
            await RestAPI.patch({
                url: `/channels/${entry.channelId}`,
                body: { rate_limit_per_user: entry.before },
                reason: "Server Safety: flood is over"
            } as any);

            await record({
                guildId: entry.guildId,
                guildName: entry.guildName,
                what: `#${entry.name} settled, slowmode back to ${entry.before}s`,
                targets: []
            });
        } catch {
            // channel gone, or the permission is. either way stop holding it
        }
    }

    await save(held.filter(one => one.why !== "flood" || one.until > Date.now()));
}

let timer = 0;

export async function putBack(channelId: string) {
    const held = await load();
    const entry = held.find(one => one.channelId === channelId);
    if (!entry) return;

    await RestAPI.patch({
        url: `/channels/${channelId}`,
        body: { rate_limit_per_user: entry.before },
        reason: "Server Safety: put back by hand"
    } as any);

    await save(held.filter(one => one.channelId !== channelId));
}

export function startAutoSlow() {
    void DataStore.get<Record<string, SlowConfig>>(CONFIG_KEY).then(found => { configs = found ?? {}; });
    void DataStore.get<Record<string, QuietConfig>>(QUIET_KEY).then(found => { quiet = found ?? {}; });
    void sweep();
    timer = window.setInterval(sweep, CHECK_EVERY);
}

export function stopAutoSlow() {
    clearInterval(timer);
    timer = 0;
}
