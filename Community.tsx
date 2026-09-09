/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Forms, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, Select, Text, Toasts, useState } from "@webpack/common";

import { record } from "./History";
import { guildChannels, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const TEXT = 0;
const LOW = 1;
const SCAN_EVERYONE = 2;
const MENTIONS_ONLY = 1;

function Community({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const already = guild.features.has("COMMUNITY");
    const mayManage = PermissionStore.can(PermissionsBits.MANAGE_GUILD, guild);
    const texts = guildChannels(guild.id).filter(one => one.type === TEXT);

    const [rules, setRules] = useState<string>(texts[0]?.id ?? "");
    const [updates, setUpdates] = useState<string>(texts[0]?.id ?? "");
    const [busy, setBusy] = useState(false);

    const g = guild as any;
    const changes = [
        `verification goes to Low${guild.verificationLevel >= LOW ? ", already there" : ""}`,
        `media is scanned for everyone${guild.explicitContentFilter === SCAN_EVERYONE ? ", already on" : ""}`,
        "notifications default to mentions only"
    ];

    async function turnOn() {
        setBusy(true);
        try {
            const before = {
                features: [...guild.features],
                rules_channel_id: g.rulesChannelId ?? null,
                public_updates_channel_id: g.publicUpdatesChannelId ?? null,
                verification_level: guild.verificationLevel,
                explicit_content_filter: guild.explicitContentFilter,
                default_message_notifications: g.defaultMessageNotifications ?? 0
            };

            const after = {
                features: [...guild.features, "COMMUNITY"],
                rules_channel_id: rules,
                public_updates_channel_id: updates,
                verification_level: Math.max(guild.verificationLevel, LOW),
                explicit_content_filter: SCAN_EVERYONE,
                default_message_notifications: MENTIONS_ONLY
            };

            await RestAPI.patch({ url: `/guilds/${guild.id}`, body: after });

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: "Turned on Community",
                targets: [{ kind: "guild", before, after }]
            });

            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Community is on" });
            modalProps.onClose();
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    async function turnOff() {
        setBusy(true);
        try {
            const before = {
                features: [...guild.features],
                rules_channel_id: g.rulesChannelId ?? null,
                public_updates_channel_id: g.publicUpdatesChannelId ?? null,
                verification_level: guild.verificationLevel,
                explicit_content_filter: guild.explicitContentFilter,
                default_message_notifications: g.defaultMessageNotifications ?? 0
            };

            const after = {
                ...before,
                features: [...guild.features].filter(one => one !== "COMMUNITY"),
                rules_channel_id: null,
                public_updates_channel_id: null
            };

            await RestAPI.patch({ url: `/guilds/${guild.id}`, body: after });

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: "Turned off Community",
                targets: [{ kind: "guild", before, after }]
            });

            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Community is off" });
            modalProps.onClose();
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Community in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {already
                            ? "Turning it off loses screening, stage channels and Discord's raid alerts."
                            : "Unlocks screening, stage channels and Discord's own raid alerts."}
                    </Text>
                </div>

                {already && (
                    <div className={cl("power-apply")}>
                        <Text variant="text-sm/normal">
                            {mayManage ? "" : "You need Manage Server here"}
                        </Text>
                        <div className={cl("safety-actions-right")}>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.RED}
                                disabled={busy || !mayManage}
                                onClick={turnOff}
                            >
                                Turn it off
                            </Button>
                        </div>
                    </div>
                )}

                {!already && (
                    <>
                        <div className={cl("chan-cols")}>
                            <div className={cl("cast-row")}>
                                <Text variant="text-sm/normal">Rules channel</Text>
                                <Select
                                    options={texts.map(one => ({ label: `#${one.name}`, value: one.id }))}
                                    select={(value: string) => setRules(value)}
                                    isSelected={value => value === rules}
                                    serialize={String}
                                />
                            </div>
                            <div className={cl("cast-row")}>
                                <Text variant="text-sm/normal">Moderator updates</Text>
                                <Select
                                    options={texts.map(one => ({ label: `#${one.name}`, value: one.id }))}
                                    select={(value: string) => setUpdates(value)}
                                    isSelected={value => value === updates}
                                    serialize={String}
                                />
                            </div>
                        </div>

                        <div className={cl("safety-detail")}>
                            Discord also changes {plural(changes.length, "setting")}: {changes.join(", ")}.
                        </div>

                        <div className={cl("power-apply")}>
                            <Text variant="text-sm/normal">
                                {mayManage ? "" : "You need Manage Server here"}
                                {mayManage && !texts.length ? "This server has no text channel to point at" : ""}
                            </Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    disabled={busy || !mayManage || !rules || !updates}
                                    onClick={turnOn}
                                >
                                    Turn it on
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openCommunityModal(guild: Guild) {
    openModal(props => <Community guild={guild} modalProps={props} />);
}
