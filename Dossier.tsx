/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import { Button, Forms, GuildStore, Modal, openModal, ScrollerThin, SnowflakeUtils, Text, useEffect, UserStore, useState } from "@webpack/common";

import { everyone } from "./departures";
import { Entry, readHistory } from "./History";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Act {
    at: number;
    what: string;
    undone: boolean;
}

interface Chapter {
    guildId: string;
    guildName: string;
    acts: Act[];
    gone?: string;
}

const touches = (entry: Entry, userId: string) =>
    entry.targets.some(target => "userId" in target && target.userId === userId);

async function gather(userId: string): Promise<Chapter[]> {
    const log = await readHistory();
    const byGuild = new Map<string, Chapter>();

    for (const entry of log.filter(one => touches(one, userId))) {
        const chapter = byGuild.get(entry.guildId) ?? { guildId: entry.guildId, guildName: entry.guildName, acts: [] };
        chapter.acts.push({ at: entry.at, what: entry.what, undone: entry.undoneAt != null });
        byGuild.set(entry.guildId, chapter);
    }

    // the departures book also holds what other moderators did, read off the audit log,
    // which history never sees
    for (const guild of Object.values(GuildStore.getGuilds())) {
        const found = (await everyone(guild.id))[userId];
        if (!found) continue;

        const chapter = byGuild.get(guild.id) ?? { guildId: guild.id, guildName: guild.name, acts: [] };
        chapter.gone = `${found.kind === "ban" ? "Banned" : "Kicked"} on ${new Date(found.at).toLocaleDateString()}${found.by ? ` by ${found.by}` : ""}`;
        byGuild.set(guild.id, chapter);
    }

    return [...byGuild.values()]
        .map(chapter => ({ ...chapter, acts: chapter.acts.sort((a, b) => b.at - a.at) }))
        .sort((a, b) => (b.acts[0]?.at ?? 0) - (a.acts[0]?.at ?? 0));
}

function Dossier({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const [chapters, setChapters] = useState<Chapter[]>();
    const user = UserStore.getUser(userId);
    const name = user?.globalName || user?.username || userId;

    useEffect(() => {
        let alive = true;
        gather(userId).then(found => { if (alive) setChapters(found); });
        return () => { alive = false; };
    }, [userId]);

    const total = chapters?.reduce((sum, chapter) => sum + chapter.acts.length, 0) ?? 0;
    const made = SnowflakeUtils.extractTimestamp(userId);

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Everything on {name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!chapters
                            ? "Reading..."
                            : chapters.length
                                ? `${plural(total, "thing")} across ${plural(chapters.length, "server")}.`
                                : "Nothing on record for them."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Account made {new Date(made).toLocaleDateString()}. History keeps the last 100 actions in total,
                        so older ones fall off.
                    </Text>
                </div>

                {chapters && chapters.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {chapters.map(chapter => (
                            <div key={chapter.guildId} className={cl("safety-row", { critical: chapter.gone != null })}>
                                <div className={cl("safety-title")}>{chapter.guildName}</div>
                                {chapter.gone && <div className={cl("joins-flags")}>{chapter.gone}</div>}
                                <div className={cl("safety-detail")}>
                                    {chapter.acts.length
                                        ? chapter.acts.map(act => (
                                            <div key={`${act.at}${act.what}`}>
                                                {new Date(act.at).toLocaleDateString()}, {act.what}
                                                {act.undone && " (undone)"}
                                            </div>
                                        ))
                                        : <div>nothing through this plugin</div>}
                                </div>
                            </div>
                        ))}
                    </ScrollerThin>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">{userId}</Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            look={Button.Looks.LINK}
                            onClick={() => openUserProfile(userId, null)}
                        >
                            Open their profile
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openDossierModal(userId: string) {
    openModal(props => <Dossier userId={userId} modalProps={props} />);
}
