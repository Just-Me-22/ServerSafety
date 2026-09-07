/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Guild } from "@vencord/discord-types";
import { GuildStore, Menu } from "@webpack/common";

import { startWatch, stopWatch } from "./liveWatch";
import { openMemberPowerModal } from "./MemberPower";
import { openGuildSafetyModal } from "./SafetyModal";
import { startWatchers, stopWatchers } from "./watchers";

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
        />
    );
};

const settings = definePluginSettings({
    liveWatch: {
        type: OptionType.BOOLEAN,
        description: "Tell me when a server gains a new critical safety problem while I am online",
        default: true
    },
    watchSpikes: {
        type: OptionType.BOOLEAN,
        description: "Tell me when a channel suddenly floods with messages",
        default: false
    },
    watchNewAccounts: {
        type: OptionType.BOOLEAN,
        description: "Tell me when a brand new account posts a link or an invite",
        default: false
    }
});

export default definePlugin({
    name: "ServerSafety",
    description: "Audits a server's permissions, watches for changes, and gives you the moderation tools to act on what it finds. Everything it writes can be undone.",
    tags: ["Servers", "Privacy", "Utility"],
    authors: [{ name: "heart_menace", id: 281162701303185408n }],
    settings,

    contextMenus: {
        "guild-context": GuildPatch,
        "guild-header-popout": GuildPatch,
        "user-context": UserPatch
    },

    start() {
        startWatch(() => settings.store.liveWatch);
        startWatchers(() => settings.store.watchSpikes, () => settings.store.watchNewAccounts);
    },

    stop() {
        stopWatch();
        stopWatchers();
    }
});
