/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild } from "@vencord/discord-types";
import { Button, GuildMemberStore, GuildRoleStore, RestAPI, SnowflakeUtils, Text, useEffect, useState } from "@webpack/common";

import { openMemberPowerModal } from "./MemberPower";
import { canActOn, topRole } from "./moderation";
import { canModerate, openPunishModal } from "./Punish";
import { list, plural } from "./SafetyTab";
import { isWatched, toggleWatch } from "./watchers";

const cl = classNameFactory("vc-ss-");

const cdn = "https://cdn.discordapp.com";

interface Profile {
    user?: {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
        banner?: string | null;
        accent_color?: number | null;
        bio?: string | null;
    };
    user_profile?: { bio?: string | null; accent_color?: number | null; banner?: string | null; };
    guild_member?: { joined_at?: string; nick?: string | null; roles?: string[]; };
    premium_since?: string | null;
}

const since = (ms: number) => {
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return "today";
    if (days < 60) return `${plural(days, "day")} ago`;
    if (days < 730) return `${plural(Math.round(days / 30), "month")} ago`;
    return `${plural(Math.round(days / 365), "year")} ago`;
};

export function PersonCard({ guild, userId, extra, fallbackName, children }: {
    guild: Guild;
    userId: string;
    extra?: string;
    /** whatever the calling list already knew, so a refused profile still has a name */
    fallbackName?: string;
    children?: React.ReactNode;
}) {
    const [profile, setProfile] = useState<Profile | null>();
    const [watching, setWatching] = useState(isWatched(userId));

    useEffect(() => {
        let live = true;
        RestAPI.get({
            url: `/users/${userId}/profile`,
            query: { with_mutual_guilds: "false", with_mutual_friends: "false", guild_id: guild.id }
        })
            .then(({ body }) => { if (live) setProfile(body); })
            .catch(() => { if (live) setProfile(null); });
        return () => { live = false; };
    }, [userId, guild.id]);

    const user = profile?.user;
    const member = profile?.guild_member ?? GuildMemberStore.getMember(guild.id, userId);
    const made = SnowflakeUtils.extractTimestamp(userId);

    const banner = user?.banner ?? profile?.user_profile?.banner;
    const accent = user?.accent_color ?? profile?.user_profile?.accent_color;
    const bio = profile?.user_profile?.bio || user?.bio;

    const joinedAt = (member as any)?.joined_at ?? (member as any)?.joinedAt;
    const timedOut = (GuildMemberStore.getMember(guild.id, userId) as any)?.communicationDisabledUntil;
    const topHere = topRole(guild, userId);
    const roleNames = ((member as any)?.roles ?? [])
        .map((id: string) => GuildRoleStore.getRole(guild.id, id)?.name)
        .filter(Boolean) as string[];

    return (
        <div className={cl("card")}>
            <div
                className={cl("card-banner")}
                style={{
                    backgroundImage: banner ? `url(${cdn}/banners/${userId}/${banner}.png?size=480)` : undefined,
                    backgroundColor: accent != null ? `#${accent.toString(16).padStart(6, "0")}` : undefined
                }}
            />

            <div className={cl("card-body")}>
                {user?.avatar
                    ? <img className={cl("card-avatar")} src={`${cdn}/avatars/${userId}/${user.avatar}.png?size=128`} alt="" />
                    : <div className={cl("card-avatar", "servers-icon-empty")} aria-hidden />}

                <div className={cl("card-names")}>
                    <Text variant="text-md/semibold">
                        {(member as any)?.nick || user?.global_name || user?.username || fallbackName || "Someone"}
                    </Text>
                    <Text variant="text-sm/normal">{user ? `@${user.username}` : fallbackName ? `id ${userId}` : userId}</Text>
                </div>

                <div className={cl("card-facts")}>
                    <div><span className={cl("safety-channels-label")}>Account made</span>{new Date(made).toLocaleDateString()}, {since(Date.now() - made)}</div>
                    {joinedAt && (
                        <div>
                            <span className={cl("safety-channels-label")}>Joined here</span>
                            {new Date(joinedAt).toLocaleDateString()}, {since(Date.now() - new Date(joinedAt).getTime())}
                        </div>
                    )}
                    {!joinedAt && profile !== undefined && (
                        <div><span className={cl("safety-channels-label")}>Joined here</span>not a member any more</div>
                    )}
                    {roleNames.length > 0 && (
                        <div><span className={cl("safety-channels-label")}>Roles</span>{list(roleNames)}</div>
                    )}
                    {profile?.premium_since && (
                        <div><span className={cl("safety-channels-label")}>Boosting since</span>{new Date(profile.premium_since).toLocaleDateString()}</div>
                    )}
                    <div><span className={cl("safety-channels-label")}>User id</span>{userId}</div>
                    {topHere >= 0 && (
                        <div>
                            <span className={cl("safety-channels-label")}>Standing</span>
                            {canActOn(guild, userId) ? "below you, so you can act on them" : "at or above you, so you cannot act on them"}
                        </div>
                    )}
                    {timedOut && (
                        <div><span className={cl("safety-channels-label")}>Timed out</span>until {new Date(timedOut).toLocaleString()}</div>
                    )}
                    {extra && <div><span className={cl("safety-channels-label")}>Note</span>{extra}</div>}
                    {bio && <div className={cl("card-bio")}>{bio}</div>}
                    {profile === undefined && <div>Reading their profile...</div>}
                    {profile === null && (
                        <div>
                            Discord would not return their full profile, which usually means you share
                            nothing with them or they have blocked profile lookups. Everything above still
                            holds: the account age comes from the id itself and cannot be hidden.
                        </div>
                    )}
                    {children}
                </div>

                <div className={cl("safety-row-actions")}>
                    <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => openMemberPowerModal(guild, userId)}>
                        What they can do
                    </Button>
                    {canModerate(guild) && (
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => openPunishModal(guild, userId)}>
                            Act on them
                        </Button>
                    )}
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => toggleWatch(userId).then(setWatching)}
                    >
                        {watching ? "Stop watching them" : "Watch them"}
                    </Button>
                </div>
            </div>
        </div>
    );
}
