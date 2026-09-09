/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Forms, Modal, openModal, PermissionsBits, PermissionStore, Select, Text, Toasts, useEffect, useState } from "@webpack/common";

import { LEVELS, pendingRaidHolds, RaidConfig, raidConfigFor, releaseRaidHold, setRaidConfig } from "./raidGuard";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const JOINS = [3, 5, 10, 15, 20, 30, 50];
const WINDOWS = [10, 30, 60, 300];
const MINUTES = [10, 30, 60, 120, 360];

const per = (seconds: number) =>
    seconds === 60 ? "a minute" : seconds === 300 ? "five minutes" : `${seconds} seconds`;

function RaidPanel({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const mayManage = PermissionStore.can(PermissionsBits.MANAGE_GUILD, guild);

    const [config, setLocal] = useState<RaidConfig>(() => raidConfigFor(guild.id));
    const [holding, setHolding] = useState<{ before: number; after: number; until: number; }>();

    async function refresh() {
        setHolding((await pendingRaidHolds()).find(one => one.guildId === guild.id));
    }

    useEffect(() => {
        let alive = true;
        pendingRaidHolds().then(all => {
            if (alive) setHolding(all.find(one => one.guildId === guild.id));
        });
        return () => { alive = false; };
    }, [guild.id]);

    async function change(next: RaidConfig) {
        setLocal(next);
        await setRaidConfig(guild.id, next);
    }

    // raising to at or below where the server already sits would do nothing
    const pointless = guild.verificationLevel >= config.level;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Raid guard in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {config.on
                            ? `${config.joins} joins in ${per(config.window)} puts verification on ${LEVELS[config.level]} for ${plural(config.minutes, "minute")}, then back.`
                            : "Off. A rush of joins is left alone."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Verification decides who can talk at all: Low needs a verified email, Medium five
                        minutes of membership, High ten minutes, Highest a verified phone.
                    </Text>
                    {!mayManage && <Text variant="text-sm/normal">You need Manage Server here for it to do anything.</Text>}
                    {config.on && pointless && (
                        <Text variant="text-sm/normal">
                            This server already sits on {LEVELS[guild.verificationLevel]}, so nothing would change. Pick a higher one.
                        </Text>
                    )}
                </div>

                <FormSwitch
                    hideBorder
                    title="Raise verification when people pour in"
                    value={config.on}
                    onChange={on => void change({ ...config, on })}
                />

                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Trips at</Text>
                        <Select
                            options={JOINS.map(value => ({ label: plural(value, "join"), value }))}
                            select={(joins: number) => void change({ ...config, joins })}
                            isSelected={value => value === config.joins}
                            serialize={String}
                        />
                    </div>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Within</Text>
                        <Select
                            options={WINDOWS.map(value => ({ label: per(value), value }))}
                            select={(window: number) => void change({ ...config, window })}
                            isSelected={value => value === config.window}
                            serialize={String}
                        />
                    </div>
                </div>

                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Raise it to</Text>
                        <Select
                            options={LEVELS.map((label, value) => ({ label, value })).slice(1)}
                            select={(level: number) => void change({ ...config, level })}
                            isSelected={value => value === config.level}
                            serialize={String}
                        />
                    </div>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Hold it for</Text>
                        <Select
                            options={MINUTES.map(value => ({ label: plural(value, "minute"), value }))}
                            select={(minutes: number) => void change({ ...config, minutes })}
                            isSelected={value => value === config.minutes}
                            serialize={String}
                        />
                    </div>
                </div>

                {holding && (
                    <div className={cl("power-apply")}>
                        <Text variant="text-sm/normal">
                            Holding {LEVELS[holding.after]} now, was {LEVELS[holding.before]}, back in{" "}
                            {plural(Math.max(1, Math.round((holding.until - Date.now()) / 60_000)), "minute")}
                        </Text>
                        <div className={cl("safety-actions-right")}>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={async () => {
                                    await releaseRaidHold(guild.id);
                                    await refresh();
                                    Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `Back to ${LEVELS[holding.before]}` });
                                }}
                            >
                                Put it back now
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openRaidPanel(guild: Guild) {
    openModal(props => <RaidPanel guild={guild} modalProps={props} />);
}
