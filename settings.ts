/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
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
    },
    purgeCap: {
        type: OptionType.NUMBER,
        description: "Most messages one clear can delete. A user account has no bulk delete, so this is one request each, paced about a second apart. 100 takes two minutes and looks like ordinary moderation; 1000 takes twenty and looks like a script.",
        default: 100
    }
});
