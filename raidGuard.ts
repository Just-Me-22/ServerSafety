/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { GuildStore, PermissionsBits, PermissionStore, RestAPI } from "@webpack/common";

import { record } from "./History";

const HELD_KEY = "serverSafety-raidGuard";
const CONFIG_KEY = "serverSafety-raidGuard-config";
const CHECK_EVERY = 60_000;

export const LEVELS = ["None", "Low", "Medium", "High", "Highest"];

export interface RaidConfig {
    on: boolean;
    /** how many joins inside the window counts as a raid */
    joins: number;
    /** the window, in seconds */
    window: number;
    /** the verification level to raise to */
    level: number;
    /** how long to hold it there */
    minutes: number;
}

const OFF: RaidConfig = { on: false, joins: 10, window: 60, level: 3, minutes: 30 };

interface Held {
    guildId: string;
    guildName: string;
    before: number;
    after: number;
    until: number;
}

let configs: Record<string, RaidConfig> = {};

export const raidConfigFor = (guildId: string): RaidConfig => configs[guildId] ?? OFF;

export async function setRaidConfig(guildId: string, next: RaidConfig) {
    configs = { ...configs, [guildId]: next };
    await DataStore.set(CONFIG_KEY, configs);
}

const load = async () => (await DataStore.get<Held[]>(HELD_KEY)) ?? [];
const save = (held: Held[]) => DataStore.set(HELD_KEY, held);

export const pendingRaidHolds = load;

/** join times per guild, in memory only. a raid that spans a restart is a raid the
 *  client was not there for. */
const arrivals = new Map<string, number[]>();

export async function noteJoin(guildId: string) {
    const config = raidConfigFor(guildId);
    if (!config.on) return;

    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const now = Date.now();
    const times = (arrivals.get(guildId) ?? []).filter(at => now - at < config.window * 1000);
    times.push(now);
    arrivals.set(guildId, times);

    if (times.length < config.joins) return;
    if (!PermissionStore.can(PermissionsBits.MANAGE_GUILD, guild)) return;

    const held = await load();
    if (held.some(one => one.guildId === guildId)) return;

    const before = guild.verificationLevel;
    if (before >= config.level) return;

    await RestAPI.patch({
        url: `/guilds/${guildId}`,
        body: { verification_level: config.level }
    });

    await save([...held, {
        guildId,
        guildName: guild.name,
        before,
        after: config.level,
        until: now + config.minutes * 60_000
    }]);

    await record({
        guildId,
        guildName: guild.name,
        what: `${times.length} joined in ${config.window} seconds, raised verification to ${LEVELS[config.level]}`,
        targets: [{
            kind: "guild",
            before: { verification_level: before, explicit_content_filter: guild.explicitContentFilter },
            after: { verification_level: config.level, explicit_content_filter: guild.explicitContentFilter }
        }]
    });

    showNotification({
        title: `${guild.name} is being raided`,
        body: `${times.length} joined in ${config.window} seconds. Verification is on ${LEVELS[config.level]} for ${config.minutes} minutes.`
    });
}

export async function releaseRaidHold(guildId: string) {
    const held = await load();
    const entry = held.find(one => one.guildId === guildId);
    if (!entry) return;

    await RestAPI.patch({
        url: `/guilds/${guildId}`,
        body: { verification_level: entry.before }
    });

    arrivals.delete(guildId);
    await save(held.filter(one => one.guildId !== guildId));
}

async function sweep() {
    const held = await load();
    const due = held.filter(one => one.until <= Date.now());
    if (!due.length) return;

    for (const entry of due) {
        try {
            await RestAPI.patch({
                url: `/guilds/${entry.guildId}`,
                body: { verification_level: entry.before }
            });

            await record({
                guildId: entry.guildId,
                guildName: entry.guildName,
                what: `The rush is over, verification back to ${LEVELS[entry.before]}`,
                targets: []
            });
        } catch {
            // no longer in the server, or the permission is gone. stop holding it either way
        }

        arrivals.delete(entry.guildId);
    }

    await save(held.filter(one => one.until > Date.now()));
}

let timer = 0;

export function startRaidGuard() {
    void DataStore.get<Record<string, RaidConfig>>(CONFIG_KEY).then(found => { configs = found ?? {}; });
    void sweep();
    timer = window.setInterval(sweep, CHECK_EVERY);
}

export function stopRaidGuard() {
    clearInterval(timer);
    timer = 0;
    arrivals.clear();
}
