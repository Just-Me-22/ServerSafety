/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Forms, GuildStore, Modal, openModal, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { pendingSlowmode, putBack, quietConfigFor } from "./autoSlow";
import { panicKey, restoreLockdown, Snapshot } from "./lockdown";
import { LEVELS,pendingRaidHolds, releaseRaidHold } from "./raidGuard";
import { plural } from "./SafetyTab";
import { cancelUnban, pendingUnbans } from "./tempBans";

const cl = classNameFactory("vc-ss-");

interface Job {
    id: string;
    where: string;
    what: string;
    when: string;
    stop?: { label: string; run: () => Promise<void>; };
}

const soon = (until: number) => {
    const minutes = Math.round((until - Date.now()) / 60_000);
    if (minutes < 1) return "any moment";
    if (minutes < 90) return `in ${plural(minutes, "minute")}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${plural(hours, "hour")}`;
    return `in ${plural(Math.round(hours / 24), "day")}`;
};

async function gather(): Promise<Job[]> {
    const jobs: Job[] = [];

    for (const ban of await pendingUnbans()) {
        jobs.push({
            id: `ban:${ban.guildId}:${ban.userId}`,
            where: ban.guildName,
            what: `${ban.name} is banned until it lifts`,
            when: soon(ban.until),
            stop: { label: "Make it permanent", run: () => cancelUnban(ban.guildId, ban.userId) }
        });
    }

    for (const held of await pendingSlowmode()) {
        jobs.push({
            id: `slow:${held.channelId}`,
            where: held.guildName,
            what: `#${held.name} is on ${held.after}s slowmode, was ${held.before}s`,
            when: held.why === "quiet" ? "until the quiet hours end" : soon(held.until),
            stop: { label: "Put it back now", run: () => putBack(held.channelId) }
        });
    }

    for (const hold of await pendingRaidHolds()) {
        jobs.push({
            id: `raid:${hold.guildId}`,
            where: hold.guildName,
            what: `verification is on ${LEVELS[hold.after]}, was ${LEVELS[hold.before]}`,
            when: soon(hold.until),
            stop: { label: "Put it back now", run: () => releaseRaidHold(hold.guildId) }
        });
    }

    for (const guild of Object.values(GuildStore.getGuilds())) {
        const saved = await DataStore.get<Snapshot>(panicKey(guild.id));
        if (saved) {
            jobs.push({
                id: `lock:${guild.id}`,
                where: guild.name,
                what: "a lockdown is on",
                when: saved.unlockAt ? soon(saved.unlockAt) : "until you lift it",
                stop: { label: "Lift it now", run: async () => { await restoreLockdown(guild.id); } }
            });
        }

        const quiet = quietConfigFor(guild.id);
        if (quiet.on && quiet.channelIds.length) {
            jobs.push({
                id: `quiet:${guild.id}`,
                where: guild.name,
                what: `quiet hours are set on ${plural(quiet.channelIds.length, "channel")}`,
                when: `every day from ${String(quiet.from).padStart(2, "0")}:00`
            });
        }
    }

    return jobs;
}

function Running({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [jobs, setJobs] = useState<Job[]>();
    const [mine, setMine] = useState(true);
    const [busy, setBusy] = useState(false);

    async function refresh() {
        setJobs(await gather());
    }

    useEffect(() => {
        let alive = true;
        gather().then(found => { if (alive) setJobs(found); });
        return () => { alive = false; };
    }, []);

    const shown = (jobs ?? []).filter(job => !mine || job.where === guild.name);

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">What is running</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!jobs
                            ? "Looking..."
                            : shown.length
                                ? `${plural(shown.length, "thing")} scheduled or being held.`
                                : mine ? `Nothing running in ${guild.name}.` : "Nothing running anywhere."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Everything this plugin will do without being asked again, in one place.
                    </Text>
                </div>

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {jobs && jobs.length !== shown.length ? `${jobs.length - shown.length} more in other servers` : ""}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => setMine(!mine)}>
                            {mine ? "Show every server" : `Only ${guild.name}`}
                        </Button>
                    </div>
                </div>

                {shown.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {shown.map(job => (
                            <div key={job.id} className={cl("safety-row")}>
                                <div className={cl("safety-title")}>{job.where}</div>
                                <div className={cl("safety-detail")}>{job.what}, {job.when}</div>
                                {job.stop && (
                                    <div className={cl("safety-row-actions")}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            disabled={busy}
                                            onClick={async () => {
                                                setBusy(true);
                                                try {
                                                    await job.stop!.run();
                                                    await refresh();
                                                    Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Done" });
                                                } finally {
                                                    setBusy(false);
                                                }
                                            }}
                                        >
                                            {job.stop.label}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openRunningModal(guild: Guild) {
    openModal(props => <Running guild={guild} modalProps={props} />);
}
