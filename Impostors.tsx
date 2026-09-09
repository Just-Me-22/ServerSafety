/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import { Guild, Permissions, RenderModalProps, Role } from "@vencord/discord-types";
import { Button, Forms, GuildRoleStore, Modal, openModal, ScrollerThin, Text, useEffect, useState } from "@webpack/common";

import { openMemberPowerModal } from "./MemberPower";
import { canModerate, openPunishModal } from "./Punish";
import { RawMember, searchMembers } from "./RecentJoins";
import { has, plural } from "./SafetyTab";
import { distance, flatten } from "./text";

const cl = classNameFactory("vc-ss-");

/** holding any of these makes someone worth impersonating */
const POWER: Permissions[] = [
    "ADMINISTRATOR",
    "MANAGE_GUILD",
    "MANAGE_ROLES",
    "MANAGE_CHANNELS",
    "BAN_MEMBERS",
    "KICK_MEMBERS",
    "MODERATE_MEMBERS",
    "MANAGE_MESSAGES"
];

interface Suspect {
    userId: string;
    name: string;
    looksLike: string;
    why: string;
    close: boolean;
}

const nameOf = (entry: RawMember) =>
    entry.member.nick || entry.member.user.global_name || entry.member.user.username;

function staffRoles(guild: Guild): Set<string> {
    return new Set(
        GuildRoleStore.getSortedRoles(guild.id)
            .filter((role: Role) => role.id !== guild.id && POWER.some(perm => has(role.permissions, perm)))
            .map(role => role.id)
    );
}

function findSuspects(guild: Guild, raw: RawMember[]): Suspect[] {
    const powerful = staffRoles(guild);

    const staff = raw.filter(entry =>
        entry.member.user.id === guild.ownerId || (entry.member.roles ?? []).some(id => powerful.has(id)));

    const rest = raw.filter(entry => !staff.includes(entry));

    const marks = staff.map(entry => ({
        name: nameOf(entry),
        flat: flatten(nameOf(entry)),
        avatar: entry.member.user.avatar
    })).filter(one => one.flat.length >= 3);

    const out: Suspect[] = [];

    for (const entry of rest) {
        const name = nameOf(entry);
        const flat = flatten(name);
        const { avatar } = entry.member.user;

        for (const mark of marks) {
            const sameAvatar = avatar != null && avatar === mark.avatar;
            const gap = flat.length >= 3 ? distance(flat, mark.flat) : 99;

            if (!sameAvatar && gap > 2) continue;

            out.push({
                userId: entry.member.user.id,
                name,
                looksLike: mark.name,
                why: sameAvatar && gap === 0 ? "same name and the same picture"
                    : sameAvatar ? "the same picture"
                        : gap === 0 ? "the same name once the lookalike letters are mapped back"
                            : `${plural(gap, "letter")} away from it`,
                close: sameAvatar || gap === 0
            });
            break;
        }
    }

    return out.sort((a, b) => Number(b.close) - Number(a.close));
}

function Impostors({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const moderator = canModerate(guild);

    const [suspects, setSuspects] = useState<Suspect[]>();
    const [checked, setChecked] = useState(0);
    const [denied, setDenied] = useState(false);

    useEffect(() => {
        let alive = true;
        searchMembers(guild.id, 1000)
            .then(raw => {
                if (!alive) return;
                setChecked(raw.length);
                setSuspects(findSuspects(guild, raw));
            })
            .catch(() => { if (alive) setDenied(true); });
        return () => { alive = false; };
    }, [guild.id]);

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Lookalikes in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied
                            ? "You need one of Ban, Kick, Timeout, Manage Roles or Manage Nicknames here."
                            : !suspects
                                ? "Comparing names..."
                                : suspects.length
                                    ? `${plural(suspects.length, "person")} resembles someone with power here.`
                                    : "Nobody is dressed up as your staff."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Names are compared with the lookalike letters mapped back to latin, so Сharlie and
                        Charlie count as the same. {plural(checked, "member")} checked.
                    </Text>
                </div>

                {suspects && suspects.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {suspects.map(suspect => (
                            <div key={suspect.userId} className={cl("safety-row", { critical: suspect.close })}>
                                <button
                                    type="button"
                                    className={cl("linkish", "safety-title")}
                                    onClick={() => openUserProfile(suspect.userId, guild.id)}
                                >
                                    {suspect.name}
                                </button>
                                <div className={cl("safety-detail")}>
                                    looks like {suspect.looksLike}, {suspect.why}
                                </div>
                                <div className={cl("safety-row-actions")}>
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        look={Button.Looks.LINK}
                                        onClick={() => openMemberPowerModal(guild, suspect.userId)}
                                    >
                                        Look at them
                                    </Button>
                                    {moderator && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            onClick={() => openPunishModal(guild, suspect.userId)}
                                        >
                                            Act on them
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openImpostorsModal(guild: Guild) {
    openModal(props => <Impostors guild={guild} modalProps={props} />);
}
