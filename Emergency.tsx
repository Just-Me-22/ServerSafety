/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildRoleStore, Modal, openModal, PermissionsBits, RestAPI, ScrollerThin, Select, Text, Toasts, useEffect, useState } from "@webpack/common";

import { sendableChannels } from "./Broadcast";
import { record, Target } from "./History";
import { noteLockdown, panicKey, restoreLockdown, Snapshot } from "./lockdown";
import { everyoneIn, guildChannels, has, plural } from "./SafetyTab";
import { postTo } from "./send";

const cl = classNameFactory("vc-ss-");

const RAISED_VERIFICATION = 3;
const SCAN_EVERYONE = 2;

const HOURS = [1, 3, 6, 12, 24];

const incidents = (guild: Guild) => (guild as any).incidentsData ?? null;

function openChannels(guild: Guild) {
    const everyone = GuildRoleStore.getSortedRoles(guild.id).find(role => role.id === guild.id);
    if (!everyone) return [];

    return guildChannels(guild.id).filter(channel => {
        const permissions = everyoneIn(channel, guild.id, everyone.permissions);
        return has(permissions, "VIEW_CHANNEL") && has(permissions, "SEND_MESSAGES");
    });
}

function Emergency({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [raiseGate, setRaiseGate] = useState(true);
    const [scanMedia, setScanMedia] = useState(true);
    const [pauseInvites, setPauseInvites] = useState(true);
    const [pauseDms, setPauseDms] = useState(true);
    const [lock, setLock] = useState(false);
    const [announce, setAnnounce] = useState(false);
    const [announceIn, setAnnounceIn] = useState("");
    const [notice, setNotice] = useState("We are locking the server down for a bit while we deal with something. Sorry for the interruption.");
    const [hours, setHours] = useState(1);
    const [liftAfter, setLiftAfter] = useState(0);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState<Snapshot | null>();

    useEffect(() => {
        let live = true;
        DataStore.get<Snapshot>(panicKey(guild.id)).then(stored => { if (live) setSaved(stored ?? null); });
        return () => { live = false; };
    }, [guild.id]);

    const lockable = openChannels(guild);
    const sendable = sendableChannels(guild);
    const chosen = [raiseGate, scanMedia, pauseInvites, pauseDms, lock].some(Boolean);

    async function apply() {
        setBusy(true);
        const targets: Target[] = [];
        let logged = false;

        try {
            const current = incidents(guild);

            const snapshot: Snapshot = {
                at: Date.now(),
                verificationLevel: guild.verificationLevel,
                explicitContentFilter: guild.explicitContentFilter,
                invitesDisabledUntil: current?.invitesDisabledUntil ?? null,
                dmsDisabledUntil: current?.dmsDisabledUntil ?? null,
                channels: lock
                    ? lockable.map(channel => {
                        const overwrite = channel.permissionOverwrites?.[guild.id];
                        return {
                            id: channel.id,
                            name: channel.name,
                            allow: overwrite ? String(overwrite.allow) : null,
                            deny: overwrite ? String(overwrite.deny) : null
                        };
                    })
                    : []
            };

            await DataStore.set(panicKey(guild.id), snapshot);

            if (raiseGate || scanMedia) {
                await RestAPI.patch({
                    url: `/guilds/${guild.id}`,
                    body: {
                        ...(raiseGate ? { verification_level: RAISED_VERIFICATION } : {}),
                        ...(scanMedia ? { explicit_content_filter: SCAN_EVERYONE } : {})
                    }
                });
                targets.push({
                    kind: "guild",
                    before: {
                        verification_level: snapshot.verificationLevel,
                        explicit_content_filter: snapshot.explicitContentFilter
                    },
                    after: {
                        verification_level: raiseGate ? RAISED_VERIFICATION : snapshot.verificationLevel,
                        explicit_content_filter: scanMedia ? SCAN_EVERYONE : snapshot.explicitContentFilter
                    }
                });
            }

            if (pauseInvites || pauseDms) {
                const until = new Date(Date.now() + hours * 3600_000).toISOString();
                await RestAPI.put({
                    url: `/guilds/${guild.id}/incident-actions`,
                    body: {
                        invites_disabled_until: pauseInvites ? until : null,
                        dms_disabled_until: pauseDms ? until : null
                    }
                });
                targets.push({
                    kind: "incidents",
                    before: {
                        invites_disabled_until: snapshot.invitesDisabledUntil,
                        dms_disabled_until: snapshot.dmsDisabledUntil
                    },
                    after: {
                        invites_disabled_until: pauseInvites ? until : null,
                        dms_disabled_until: pauseDms ? until : null
                    }
                });
            }

            if (lock) {
                const send = PermissionsBits.SEND_MESSAGES;
                for (const channel of lockable) {
                    const overwrite = channel.permissionOverwrites?.[guild.id];
                    const after = {
                        allow: String((overwrite?.allow ?? 0n) & ~send),
                        deny: String((overwrite?.deny ?? 0n) | send)
                    };

                    await RestAPI.put({
                        url: `/channels/${channel.id}/permissions/${guild.id}`,
                        body: { type: 0, ...after }
                    });

                    targets.push({
                        kind: "overwrite",
                        channelId: channel.id,
                        name: channel.name,
                        before: overwrite ? { allow: String(overwrite.allow), deny: String(overwrite.deny) } : null,
                        after
                    });
                }
            }

            const entryId = await record({ guildId: guild.id, guildName: guild.name, what: plan.join(" "), targets });
            logged = true;

            const stamped: Snapshot = {
                ...snapshot,
                entryId,
                unlockAt: liftAfter ? Date.now() + liftAfter * 3_600_000 : undefined
            };
            await DataStore.set(panicKey(guild.id), stamped);
            await noteLockdown(guild.id);

            if (announce && announceIn) {
                await postTo(guild, announceIn, notice, "Announced the lockdown");
            }

            setSaved(stamped);
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Locked down. Restore is in the same window." });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            if (!logged && targets.length) {
                await record({ guildId: guild.id, guildName: guild.name, what: plan.join(" "), targets });
            }
            setBusy(false);
        }
    }

    async function restore() {
        if (!saved) return;
        setBusy(true);
        try {
            await restoreLockdown(guild.id);
            setSaved(null);
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Put back the way it was" });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    const plan = [
        raiseGate && `Verification goes to High, so an account has to have been here ten minutes before it can talk. It is currently ${guild.verificationLevel}.`,
        scanMedia && "Media from every member gets scanned.",
        pauseInvites && `Invites stop working for ${plural(hours, "hour")}.`,
        pauseDms && `Direct messages between members stop for ${plural(hours, "hour")}.`,
        lock && `@everyone loses Send Messages in ${plural(lockable.length, "channel")}.`,
        announce && announceIn && `A notice goes out in #${sendable.find(c => c.id === announceIn)?.name}.`
    ].filter(Boolean) as string[];

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Emergency, {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                {saved && (
                    <div className={cl("safety-since")}>
                        <Text variant="text-sm/semibold">
                            A lockdown from {new Date(saved.at).toLocaleString()} is still on.
                        </Text>
                        <Text variant="text-sm/normal">
                            Restore puts verification back to {saved.verificationLevel}, media scanning back to {saved.explicitContentFilter}
                            {saved.channels.length ? `, and unlocks ${plural(saved.channels.length, "channel")}` : ""}.
                            {saved.unlockAt != null && ` It lifts itself at ${new Date(saved.unlockAt).toLocaleTimeString()} if you leave it.`}
                        </Text>
                        <Button
                            className={cl("safety-toggle")}
                            size={Button.Sizes.SMALL}
                            look={Button.Looks.LINK}
                            disabled={busy}
                            onClick={restore}
                        >
                            Put it back the way it was
                        </Button>
                    </div>
                )}

                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">Everything here is recorded before it is changed.</Text>
                    <Text variant="text-sm/normal">
                        Restore puts back the exact values that were there, not Discord's defaults, so pressing this does not cost you your settings.
                    </Text>
                </div>

                <ScrollerThin className={cl("scroller")} orientation="vertical">
                    <FormSwitch
                        hideBorder
                        title="Raise the verification level"
                        description="New accounts have to wait ten minutes before they can talk"
                        value={raiseGate}
                        disabled={busy}
                        onChange={setRaiseGate}
                    />
                    <FormSwitch
                        hideBorder
                        title="Scan everyone's media"
                        value={scanMedia}
                        disabled={busy}
                        onChange={setScanMedia}
                    />
                    <FormSwitch
                        hideBorder
                        title="Pause invites"
                        description="Existing links stop working too, not just new ones"
                        value={pauseInvites}
                        disabled={busy}
                        onChange={setPauseInvites}
                    />
                    <FormSwitch
                        hideBorder
                        title="Pause direct messages between members"
                        description="Stops a raid moving into people's DMs"
                        value={pauseDms}
                        disabled={busy}
                        onChange={setPauseDms}
                    />
                    <FormSwitch
                        hideBorder
                        title={`Lock ${plural(lockable.length, "channel")}`}
                        value={lock}
                        disabled={busy || !lockable.length}
                        onChange={setLock}
                    />

                    <FormSwitch
                        hideBorder
                        title="Tell people it is happening"
                        description="A silent lockdown just looks like the server is broken"
                        value={announce}
                        disabled={busy || !sendable.length}
                        onChange={on => { setAnnounce(on); if (on && !announceIn) setAnnounceIn(sendable[0]?.id ?? ""); }}
                    />

                    {announce && (
                        <div className={cl("cast-row")}>
                            <Text variant="text-sm/normal">In</Text>
                            <Select
                                options={sendable.map(c => ({ label: `#${c.name}`, value: c.id }))}
                                select={setAnnounceIn}
                                isSelected={value => value === announceIn}
                                serialize={String}
                            />
                        </div>
                    )}

                    {announce && (
                        <textarea
                            className={cl("cast-body")}
                            value={notice}
                            disabled={busy}
                            onChange={e => setNotice(e.currentTarget.value)}
                        />
                    )}

                    {(pauseInvites || pauseDms) && (
                        <div className={cl("panic-duration")}>
                            <Text variant="text-sm/normal">Pause for</Text>
                            <Select
                                options={HOURS.map(h => ({ label: plural(h, "hour"), value: h }))}
                                select={setHours}
                                isSelected={value => value === hours}
                                serialize={String}
                            />
                        </div>
                    )}

                    <div className={cl("panic-duration")}>
                        <Text variant="text-sm/normal">Lift it by itself after</Text>
                        <Select
                            options={[{ label: "never, I will do it", value: 0 }, ...HOURS.map(h => ({ label: plural(h, "hour"), value: h }))]}
                            select={setLiftAfter}
                            isSelected={value => value === liftAfter}
                            serialize={String}
                        />
                    </div>
                </ScrollerThin>

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">Nothing has been sent yet.</Text>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.RED}
                        disabled={busy || !chosen}
                        onClick={() => Alerts.show({
                            title: `Lock down ${guild.name}?`,
                            body: <div>{plan.map(line => <p key={line}>{line}</p>)}</div>,
                            confirmText: "Do it",
                            confirmColor: Button.Colors.RED,
                            cancelText: "Cancel",
                            onConfirm: apply
                        })}
                    >
                        Lock it down
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

export function openEmergencyModal(guild: Guild) {
    openModal(props => <Emergency guild={guild} modalProps={props} />);
}
