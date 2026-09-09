/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Guild } from "@vencord/discord-types";
import { GuildStore, Menu, SelectedGuildStore } from "@webpack/common";

import { configFor, startAutoSlow, stopAutoSlow } from "./autoSlow";
import { openDossierModal } from "./Dossier";
import { startWatch, stopWatch } from "./liveWatch";
import { startUnlockTimer, stopUnlockTimer } from "./lockdown";
import { openMemberPowerModal } from "./MemberPower";
import { startRaidGuard, stopRaidGuard } from "./raidGuard";
import { openGuildSafetyModal } from "./SafetyModal";
import { settings } from "./settings";
import { startTempBans, stopTempBans } from "./tempBans";
import { startWatchers, stopWatchers } from "./watchers";
import { rulesFor, startWatchRules, stopWatchRules } from "./watchRules";

const GuildPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;

    const group = findGroupChildrenByChildId("privacy", children);

    group?.push(
        <Menu.MenuItem
            id="vc-server-safety"
            label="Server Safety"
            action={() => openGuildSafetyModal(guild)}
        />
    );
};

const UserPatch: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: { id: string; }; guildId?: string; }) => {
    if (!user || !guildId) return;

    const group = findGroupChildrenByChildId("roles", children) ?? findGroupChildrenByChildId("user-profile", children);

    group?.push(
        <Menu.MenuItem
            id="vc-member-power"
            label="What Can They Do Here"
            action={() => {
                const guild = GuildStore.getGuild(guildId);
                if (guild) openMemberPowerModal(guild, user.id);
            }}
        />,
        <Menu.MenuItem
            id="vc-member-dossier"
            label="Everything On Them"
            action={() => openDossierModal(user.id)}
        />
    );
};

/** e.code rather than e.key: on some layouts a modifier changes the character sent,
 *  and a key comparison then never matches */
function shortcut(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.code !== "KeyS") return;

    const guildId = SelectedGuildStore.getGuildId();
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    if (!guild) return;

    e.preventDefault();
    openGuildSafetyModal(guild);
}

export default definePlugin({
    name: "ServerSafety",
    description: "Audit a server's permissions, watch for changes, and act on what you find. Undo is in History.",
    tags: ["Servers", "Privacy", "Utility"],
    authors: [{ name: "heart_menace", id: 281162701303185408n }],
    settings,

    contextMenus: {
        "guild-context": GuildPatch,
        "guild-header-popout": GuildPatch,
        "user-context": UserPatch
    },

    start() {
        window.addEventListener("keydown", shortcut, true);
        startWatch(() => settings.store.liveWatch);
        startWatchers({
            spikes: guildId => rulesFor(guildId).includes("spikes"),
            newcomers: guildId => rulesFor(guildId).includes("newcomers"),
            rejoins: guildId => rulesFor(guildId).includes("rejoins"),
            firstPost: guildId => rulesFor(guildId).includes("firstpost"),
            autoSlow: guildId => {
                const one = configFor(guildId);
                return one.on ? { count: one.count, window: one.window, seconds: one.seconds, minutes: one.minutes } : null;
            }
        });
        startTempBans();
        startAutoSlow();
        startRaidGuard();
        startUnlockTimer();
        startWatchRules();
    },

    stop() {
        window.removeEventListener("keydown", shortcut, true);
        stopWatch();
        stopWatchers();
        stopTempBans();
        stopAutoSlow();
        stopRaidGuard();
        stopUnlockTimer();
        stopWatchRules();
    }
});
