/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, GuildStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Select, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { confirmBulk } from "./confirm";
import { record } from "./History";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

/** one at a time with a real gap, and never more than this in a run. a ban list is a
 *  legitimate thing to move between your own servers and also the shape of a mass ban
 *  script, so it is slow and loud on purpose. */
const CAP = 100;
const GAP = 1500;

interface Ban {
    userId: string;
    name: string;
    reason: string | null;
}

async function allBans(guildId: string): Promise<Ban[]> {
    const out: Ban[] = [];
    let after: string | undefined;

    for (;;) {
        const { body } = await RestAPI.get({
            url: `/guilds/${guildId}/bans`,
            query: after ? { limit: "1000", after } : { limit: "1000" }
        });

        const page = body as { user: { id: string; username: string; global_name?: string | null; }; reason: string | null; }[];
        out.push(...page.map(one => ({
            userId: one.user.id,
            name: one.user.global_name || one.user.username,
            reason: one.reason
        })));

        if (page.length < 1000) return out;
        after = page[page.length - 1].user.id;
    }
}

function BanTransfer({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const others = Object.values(GuildStore.getGuilds())
        .filter(one => one.id !== guild.id)
        .sort((a, b) => a.name.localeCompare(b.name));

    const [fromId, setFromId] = useState(others[0]?.id ?? "");
    const [bans, setBans] = useState<Ban[]>();
    const [here, setHere] = useState<Set<string>>(new Set());
    const [denied, setDenied] = useState(false);
    const [filter, setFilter] = useState("");
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    const source = GuildStore.getGuild(fromId);
    const mayBanHere = PermissionStore.can(PermissionsBits.BAN_MEMBERS, guild);

    useEffect(() => {
        if (!fromId) return;
        let alive = true;

        setBans(undefined);
        setTicked(new Set());
        setDenied(false);

        Promise.all([allBans(fromId), allBans(guild.id)])
            .then(([theirs, mine]) => {
                if (!alive) return;
                setHere(new Set(mine.map(one => one.userId)));
                setBans(theirs);
            })
            .catch(() => { if (alive) setDenied(true); });

        return () => { alive = false; };
    }, [fromId, guild.id]);

    const shown = (bans ?? [])
        .filter(ban => !here.has(ban.userId))
        .filter(ban => !filter.trim()
            || `${ban.name} ${ban.reason ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));

    const chosen = shown.filter(ban => ticked.has(ban.userId));

    const tick = (id: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    async function bring() {
        setBusy(true);
        let done = 0;

        try {
            for (const ban of chosen.slice(0, CAP)) {
                await RestAPI.put({
                    url: `/guilds/${guild.id}/bans/${ban.userId}`,
                    body: { delete_message_seconds: 0 },
                    reason: reason.trim() || `Brought over from ${source?.name ?? "another server"}`
                } as any);

                done++;
                setProgress(`banned ${done} of ${Math.min(chosen.length, CAP)}`);
                if (done < Math.min(chosen.length, CAP)) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${done}: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            if (done) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Brought ${plural(done, "ban")} over from ${source?.name ?? "another server"}`,
                    targets: chosen.slice(0, done).map(ban => ({ kind: "ban" as const, userId: ban.userId, name: ban.name }))
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Bring bans into {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied
                            ? "You need Ban Members in both servers."
                            : !bans
                                ? "Reading both ban lists..."
                                : `${plural(shown.length, "person")} banned there and not here.`}
                    </Text>
                    <Text variant="text-sm/normal">
                        These are people you have never met. Read the reasons before ticking anything.
                        {CAP} at a time, one every {GAP / 1000} seconds, and every one lands in History.
                    </Text>
                </div>

                <div className={cl("cast-row")}>
                    <Text variant="text-sm/normal">Take them from</Text>
                    <Select
                        options={others.map(one => ({ label: one.name, value: one.id }))}
                        select={(id: string) => setFromId(id)}
                        isSelected={value => value === fromId}
                        serialize={String}
                    />
                </div>

                <div className={cl("cast-row")}>
                    <TextInput value={filter} placeholder="Filter by name or reason, optional" onChange={setFilter} />
                </div>
                <div className={cl("cast-row")}>
                    <TextInput value={reason} placeholder="Reason to record against each ban, optional" onChange={setReason} />
                </div>

                {shown.length > 0 && (
                    <>
                        <div className={cl("purge-pick")}>
                            <Text variant="text-sm/normal">{chosen.length} of {shown.length} ticked</Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy || !ticked.size}
                                    onClick={() => setTicked(new Set())}
                                >
                                    Untick all
                                </Button>
                            </div>
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {shown.slice(0, 300).map(ban => (
                                <div key={ban.userId} className={cl("safety-row")}>
                                    <Checkbox
                                        value={ticked.has(ban.userId)}
                                        onChange={() => tick(ban.userId)}
                                        disabled={busy || !mayBanHere}
                                        align="top"
                                    >
                                        <div className={cl("safety-title")}>{ban.name}</div>
                                        <div className={cl("safety-detail")}>{ban.reason || "no reason given there either"}</div>
                                    </Checkbox>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (chosen.length > CAP
                            ? `${plural(chosen.length, "person")} ticked, only the first ${CAP} go`
                            : chosen.length
                                ? `${plural(chosen.length, "person")} ticked, about ${Math.ceil(chosen.length * GAP / 60000)} minute(s)`
                                : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !mayBanHere || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Ban ${plural(Math.min(chosen.length, CAP), "person")} here?`,
                                items: chosen.slice(0, CAP).map(ban => ban.name),
                                warning: `They have done nothing in ${guild.name}, so you are trusting the other server's moderators. Undo is one at a time, in the Bans screen.`,
                                verb: "Ban them here",
                                onConfirm: () => void bring()
                            })}
                        >
                            Ban ticked here
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openBanTransferModal(guild: Guild) {
    openModal(props => <BanTransfer guild={guild} modalProps={props} />);
}
