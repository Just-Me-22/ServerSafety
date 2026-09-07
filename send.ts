/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Guild } from "@vencord/discord-types";
import { ChannelStore, RestAPI } from "@webpack/common";

import { record } from "./History";

const alertKey = (guildId: string) => `serverInfo-alerts-${guildId}`;

export const alertChannel = async (guildId: string) =>
    (await DataStore.get<{ channelId: string; }>(alertKey(guildId)))?.channelId ?? null;

export const setAlertChannel = (guildId: string, channelId: string | null) =>
    channelId ? DataStore.set(alertKey(guildId), { channelId }) : DataStore.del(alertKey(guildId));

/** posts and writes it to History, so anything this plugin says can be taken back.
 *  nothing in the text can ping: only what a caller explicitly allows ever does. */
export async function postTo(guild: Guild, channelId: string, content: string, what: string) {
    const { body: message } = await RestAPI.post({
        url: `/channels/${channelId}/messages`,
        body: { content, allowed_mentions: { parse: [], roles: [], users: [] } }
    });

    await record({
        guildId: guild.id,
        guildName: guild.name,
        what,
        targets: [{
            kind: "message",
            channelId,
            name: ChannelStore.getChannel(channelId)?.name ?? channelId,
            messageId: message.id
        }]
    });

    return message.id as string;
}
