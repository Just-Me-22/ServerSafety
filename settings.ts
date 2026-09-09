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
        description: "Tell me about new critical problems while I am online",
        default: true
    },
    watchSpikes: {
        type: OptionType.BOOLEAN,
        description: "Tell me when a channel floods",
        default: false
    },
    watchNewAccounts: {
        type: OptionType.BOOLEAN,
        description: "Tell me when a new account posts a link or invite",
        default: false
    },
    joinsCount: {
        type: OptionType.NUMBER,
        description: "How many recent joins to load. Discord caps this at 1000.",
        default: 50
    },
    purgeCap: {
        type: OptionType.NUMBER,
        description: "Most messages one clear can delete. Roughly a second each.",
        default: 100
    }
});
