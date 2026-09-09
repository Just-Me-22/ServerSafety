/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, Modal, openModal, PermissionsBits, PermissionStore, ScrollerThin, Select, Text, Toasts, useEffect, useState } from "@webpack/common";

import { configFor, inWindow, pendingSlowmode, putBack, QuietConfig, quietConfigFor, setConfig, setQuietConfig, SlowConfig } from "./autoSlow";
import { guildChannels, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const SECONDS = [5, 10, 15, 30, 60, 120, 300];
const MINUTES = [5, 10, 20, 30, 60, 120];
const COUNTS = [5, 10, 15, 20, 25, 40, 60, 100];
const WINDOWS = [5, 10, 30, 60];

const per = (seconds: number) => seconds === 60 ? "a minute" : `${seconds} seconds`;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const TEXT = 0;

const oClock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

interface Held {
    guildId: string;
    channelId: string;
    name: string;
    before: number;
    after: number;
    until: number;
    why: "flood" | "quiet";
}

const wait = (ms: number) => {
    const minutes = Math.round(ms / 60_000);
    return minutes < 1 ? "any moment" : `in ${plural(minutes, "minute")}`;
};

function AutoSlow({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const mayManage = PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, guild);

    const [config, setLocal] = useState<SlowConfig>(() => configFor(guild.id));
    const [held, setHeld] = useState<Held[]>([]);

    async function refresh() {
        setHeld((await pendingSlowmode()).filter(one => one.guildId === guild.id));
    }

    useEffect(() => {
        let alive = true;
        pendingSlowmode().then(all => { if (alive) setHeld(all.filter(one => one.guildId === guild.id)); });
        return () => { alive = false; };
    }, [guild.id]);

    async function change(next: SlowConfig) {
        setLocal(next);
        await setConfig(guild.id, next);
    }

    const [night, setNight] = useState<QuietConfig>(() => quietConfigFor(guild.id));
    const texts = guildChannels(guild.id).filter(one => one.type === TEXT);
    const open = night.on && inWindow(new Date().getHours(), night.from, night.to);

    async function changeNight(next: QuietConfig) {
        setNight(next);
        await setQuietConfig(guild.id, next);
        await refresh();
    }

    const pickChannel = (channelId: string) => {
        const picked = night.channelIds.includes(channelId)
            ? night.channelIds.filter(one => one !== channelId)
            : [...night.channelIds, channelId];
        void changeNight({ ...night, channelIds: picked });
    };

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Auto slowmode in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {config.on
                            ? `${config.count} messages in ${per(config.window)} puts a channel on ${config.seconds}s slowmode for ${plural(config.minutes, "minute")}, then back.`
                            : "Off. A flooding channel is left alone."}
                    </Text>
                    <Text variant="text-sm/normal">
                        It never lowers a slowmode you set yourself, and it puts back whatever was there before.
                    </Text>
                    {!mayManage && <Text variant="text-sm/normal">You need Manage Channels here for it to do anything.</Text>}
                </div>

                <FormSwitch
                    hideBorder
                    title="Slow a flooding channel down by itself"
                    value={config.on}
                    onChange={on => void change({ ...config, on })}
                />

                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Trips at</Text>
                        <Select
                            options={COUNTS.map(value => ({ label: plural(value, "message"), value }))}
                            select={(count: number) => void change({ ...config, count })}
                            isSelected={value => value === config.count}
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
                        <Text variant="text-sm/normal">Slowmode to set</Text>
                        <Select
                            options={SECONDS.map(value => ({ label: value >= 60 ? `${value / 60} min` : `${value}s`, value }))}
                            select={(seconds: number) => void change({ ...config, seconds })}
                            isSelected={value => value === config.seconds}
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

                <hr className={cl("rule")} />

                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {night.on
                            ? `${night.channelIds.length ? plural(night.channelIds.length, "channel") : "No channel"} on ${night.seconds}s slowmode between ${oClock(night.from)} and ${oClock(night.to)}${open ? ", which is now" : ""}.`
                            : "Quiet hours are off."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Set the end before the start to run over midnight. It leaves alone any channel
                        already held for flooding.
                    </Text>
                </div>

                <FormSwitch
                    hideBorder
                    title="Slow chosen channels down at set hours"
                    value={night.on}
                    onChange={on => void changeNight({ ...night, on })}
                />

                <div className={cl("chan-cols")}>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">From</Text>
                        <Select
                            options={HOURS.map(value => ({ label: oClock(value), value }))}
                            select={(from: number) => void changeNight({ ...night, from })}
                            isSelected={value => value === night.from}
                            serialize={String}
                        />
                    </div>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Until</Text>
                        <Select
                            options={HOURS.map(value => ({ label: oClock(value), value }))}
                            select={(to: number) => void changeNight({ ...night, to })}
                            isSelected={value => value === night.to}
                            serialize={String}
                        />
                    </div>
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Slowmode</Text>
                        <Select
                            options={SECONDS.map(value => ({ label: value >= 60 ? `${value / 60} min` : `${value}s`, value }))}
                            select={(seconds: number) => void changeNight({ ...night, seconds })}
                            isSelected={value => value === night.seconds}
                            serialize={String}
                        />
                    </div>
                </div>

                {night.on && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {texts.map(channel => (
                            <div key={channel.id} className={cl("chan-row")}>
                                <Checkbox
                                    value={night.channelIds.includes(channel.id)}
                                    onChange={() => pickChannel(channel.id)}
                                >
                                    <Text variant="text-sm/normal">#{channel.name}</Text>
                                </Checkbox>
                            </div>
                        ))}
                    </ScrollerThin>
                )}

                {held.length > 0 && (
                    <>
                        <Text variant="text-md/semibold">Held right now</Text>
                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {held.map(one => (
                                <div key={one.channelId} className={cl("safety-row")}>
                                    <div className={cl("safety-title")}>#{one.name}</div>
                                    <div className={cl("safety-detail")}>
                                        on {one.after}s, was {one.before}s,
                                        {one.why === "quiet" ? " back when the quiet hours end" : ` back ${wait(one.until - Date.now())}`}
                                    </div>
                                    <div className={cl("safety-row-actions")}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            onClick={async () => {
                                                await putBack(one.channelId);
                                                await refresh();
                                                Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `#${one.name} is back to ${one.before}s` });
                                            }}
                                        >
                                            Put it back now
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openAutoSlowModal(guild: Guild) {
    openModal(props => <AutoSlow guild={guild} modalProps={props} />);
}
