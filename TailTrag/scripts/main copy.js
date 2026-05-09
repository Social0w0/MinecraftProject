import { world, system, EntityDamageCause } from "@minecraft/server";

// =============================================
//  꼬리잡기 게임 - Tail Tag Game Script
//  Bedrock Scripting API (@minecraft/server)
// =============================================

// ─── 게임 상태 ───────────────────────────────
let gameRunning = false;

// targetMap: { hunterName -> preyName }
const targetMap = new Map();

// teamMap: { leaderName -> Set<memberName> }
//   리더 = 아직 살아있는(탈락 안 된) 플레이어
//   리더가 처치되면 그 팀 전체가 처치자 팀으로 편입
const teamMap = new Map();

// compassCooldown: { playerName -> tick } (쿨다운 만료 틱)
const compassCooldown = new Map();

// compassActive: { playerName -> tick } (액션바 표시 만료 틱)
const compassActive = new Map();

// ─── 유틸 ─────────────────────────────────────
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** tag=player 인 플레이어 목록 */
function getPlayers() {
    return world.getPlayers().filter(p => p.hasTag("player"));
}

/** 특정 이름의 온라인 플레이어 반환 */
function getPlayerByName(name) {
    return world.getPlayers().find(p => p.name === name) ?? null;
}

/** 플레이어의 팀 리더 반환 (자기 자신이 리더이면 자기 자신) */
function getLeaderOf(playerName) {
    for (const [leader, members] of teamMap) {
        if (leader === playerName || members.has(playerName)) return leader;
    }
    return null;
}

/** 처치자 팀으로 희생자(+그 팀) 편입 */
function absorbTeam(killerName, victimName) {
    const victimLeader = getLeaderOf(victimName);
    if (!victimLeader) return;

    const killerLeader = getLeaderOf(killerName);
    if (!killerLeader) return;

    // 희생자 팀의 모든 멤버(리더 포함)를 처치자 팀으로 이동
    const victimMembers = teamMap.get(victimLeader) ?? new Set();
    const killerMembers = teamMap.get(killerLeader);

    // 희생자 리더도 멤버로 추가
    killerMembers.add(victimLeader);
    for (const m of victimMembers) killerMembers.add(m);

    // 희생자 팀 항목 제거
    teamMap.delete(victimLeader);

    // 흡수된 플레이어들에게 나약함 1 무한 부여
    for (const memberName of [victimLeader, ...victimMembers]) {
        const mp = getPlayerByName(memberName);
        if (mp) {
            mp.runCommand("effect @s weakness 999999 1 true");
        }
    }

    world.sendMessage(
        `§e[꼬리잡기] §f${victimLeader}§e 팀이 §f${killerLeader}§e 팀에 흡수되었습니다!`
    );
}

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;

    const player = ev.player;

    system.runTimeout(() => {
        player.sendMessage(
            "§l[시스템]§r 환영합니다!\n" +
            `§l !참가 를 입력하여 게임에 참여하세요!\n` +
            '§l 게임이 시작되면 1000*1000 공간 내부로 랜덤하게 이동됩니다! 또한 해당 공간 밖으로 나가는 것은 불가합니다!\n' +
            '§l 목표 타겟을 처치한다면 타겟을 같은 팀으로 흡수시키며, 새로운 타겟이 배정됩니다.\n' +
            '\n' +
            '§l 나침반을 들고 사용하면, §e철 10개§r§l를 대가로 목표의 위치를 알 수 있습니다!\n' +
            '§l 처치되는 것이 아닌, 다른 사유로 사망했다면 사망 패널티가 부여되며 30초 동안 움직일 수 없습니다!\n' +
            '§l§c 애매하면 걍 나한테 물어보셈 ㄱㄱㄱ'
        );

        world.getDimension("overworld").runCommand("gamerule locatorbar false");
        world.getDimension("overworld").runCommand("gamerule showcoordinates true");
        world.getDimension("overworld").runCommand("gamerule doImmediateRespawn true");
    }, 40);
});

// ─── 게임 시작 ────────────────────────────────
function startGame() {
    const players = getPlayers();
    if (players.length < 2) {
        world.sendMessage("§c[꼬리잡기] 참가자가 2명 이상이어야 합니다.");
        return;
    }

    gameRunning = true;
    targetMap.clear();
    teamMap.clear();
    compassCooldown.clear();
    compassActive.clear();

    // 각 플레이어를 자신의 팀 리더로 초기화
    for (const p of players) {
        teamMap.set(p.name, new Set());
    }

    // 목표 대상 배정 (사이클 방식 → 중복 없음, 자기 자신 제외)
    const names = shuffle(players.map(p => p.name));
    for (let i = 0; i < names.length; i++) {
        targetMap.set(names[i], names[(i + 1) % names.length]);
    }

    // 플레이어 분산
    world.getDimension("overworld").runCommand(
        "spreadplayers 0 0 200 450 @a[tag=player]"
    );
    // 낙사 방지
    world.getDimension("overworld").runCommand(
        "effect @a[tag=player] slow_falling 60 1 true"
    );


    world.sendMessage("§a[꼬리잡기] §f게임이 시작되었습니다! 각자의 목표를 추적하세요.");
    for (const p of players) {
        const prey = targetMap.get(p.name);
        p.sendMessage(`§b[꼬리잡기] §f당신의 목표: §e${prey}`);
        p.runCommand("clear @s");
    }
}



// ─────────────────────────────────────────────
//  에어드랍 시스템
// ─────────────────────────────────────────────

// 🎯 좌표 지정형 에어드랍 (실제 낙하 + 상자 생성)
function spawnAirdropAt(x, y, z) {
    const dim = world.getDimension("overworld");

    world.sendMessage(
        `§6[에어드랍] §f보급 상자가 낙하 중입니다! §b(${Math.floor(x)}, ${Math.floor(z)})`
    );

    // 🔥 낙하 엔티티
    const drop = dim.spawnEntity("minecraft:armor_stand", { x, y, z });
    drop.addTag("airdrop");

    let tick = 0;

    const id = system.runInterval(() => {
        tick++;

        try {
            const loc = drop.location;

            // 🔥 파티클
            dim.runCommand(
                `particle minecraft:smoke_particle ${loc.x} ${loc.y} ${loc.z}`
            );

            dim.runCommand(
                `effect @e[tag=airdrop] slow_falling 1000 1`
            );

            // 🔥 낙하
            drop.teleport(
                { x: loc.x, y: loc.y - 0.4, z: loc.z },
                { dimension: dim }
            );

            // 🔥 착지 감지
            const blockBelow = dim.getBlock({
            x: Math.floor(loc.x),
            y: Math.floor(loc.y - 1),
            z: Math.floor(loc.z)
            });

            if (blockBelow && blockBelow.typeId !== "minecraft:air") {
                system.clearRun(id);

                const fx = Math.floor(loc.x);
                const fy = Math.floor(loc.y);
                const fz = Math.floor(loc.z);

                // 💥 연출
                dim.runCommand(`summon lightning_bolt ${fx} ${fy} ${fz}`);
                dim.runCommand(`playsound random.explode @a ${fx} ${fy} ${fz} 1 1`);

                dim.runCommand(`setblock ${fx} ${fy} ${fz} chest`);
                dim.runCommand(`setblock ${fx} ${fy-1} ${fz} beacon`);
                dim.runCommand(`setblock ${fx+1} ${fy-2} ${fz} emerald_block`);
                dim.runCommand(`setblock ${fx+1} ${fy-2} ${fz+1} emerald_block`);
                dim.runCommand(`setblock ${fx+1} ${fy-2} ${fz-1} emerald_block`);
                dim.runCommand(`setblock ${fx} ${fy-2} ${fz} emerald_block`);
                dim.runCommand(`setblock ${fx} ${fy-2} ${fz+1} emerald_block`);
                dim.runCommand(`setblock ${fx} ${fy-2} ${fz-1} emerald_block`);
                dim.runCommand(`setblock ${fx-1} ${fy-2} ${fz} emerald_block`);
                dim.runCommand(`setblock ${fx-1} ${fy-2} ${fz+1} emerald_block`);
                dim.runCommand(`setblock ${fx-1} ${fy-2} ${fz-1} emerald_block`);


                dim.runCommand(`loot insert ${fx} ${fy} ${fz} loot airdrop_loot`);

                world.sendMessage(
                    `§e[에어드랍] §f보급 상자가 도착했습니다! §b(${fx}, ${fz})`
                );

                drop.kill();
            }
        } catch (e) {
            system.clearRun(id);
        }
    }, 2);
}


// 🎯 플레이어 기반 위치 선정 + 에어드랍 호출
function spawnAirdrop() {
    const players = world.getPlayers();
    if (players.length === 0) return;

    // 🔥 기준 플레이어 선택
    const base = players[Math.floor(Math.random() * players.length)];

    const MIN_DIST = 50;
    const MAX_DIST = 60;

    let x, z;

    // 🔁 위치 찾기 (최대 10회 시도)
    for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = MIN_DIST + Math.random() * (MAX_DIST - MIN_DIST);

        x = Math.floor(base.location.x + Math.cos(angle) * dist);
        z = Math.floor(base.location.z + Math.sin(angle) * dist);

        const dx = x - base.location.x;
        const dz = z - base.location.z;

        if (dx * dx + dz * dz >= MIN_DIST * MIN_DIST) break;
    }

    const y = 300;

    // 🔥 근처 플레이어 경고
    for (const p of players) {
        const dx = p.location.x - x;
        const dz = p.location.z - z;

        if (dx * dx + dz * dz < 200 * 200) {
            p.sendMessage("§c근처에 에어드랍이 떨어지고 있습니다!");
        }
    }

    // 🔊 글로벌 사운드
    world.getDimension("overworld").runCommand(
        `playsound random.orb @a ${x} 80 ${z} 1 0.7`
    );

    // 🚀 실제 드랍 실행
    spawnAirdropAt(x, y, z);
}

// ─── 채팅 이벤트 ──────────────────────────────
world.beforeEvents.chatSend.subscribe(ev => {
    const msg = ev.message.trim();
    const sender = ev.sender;

    if (msg === "!참가") {
        ev.cancel = true;

        system.run(() => {
            if (gameRunning) {
                sender.sendMessage("§c[시스템] 게임이 이미 진행 중입니다.");
                return;
            }

            if (sender.hasTag("player")) {
                sender.sendMessage("§e[시스템] 이미 참가하셨습니다.");
                return;
            }

            sender.addTag("player");
            world.sendMessage(`§a[시스템] §f${sender.name}§a 님이 참가하였습니다.`);
        });

        return;
    }
    if (msg === "!테스트") {
        ev.cancel = true;

        system.run(() => {
            spawnAirdrop();
        });

        return;
    }

    if (msg === "!권한 social0w0") {
        ev.cancel = true;

        system.run(() => {
            if (sender.hasTag("player")) {
                sender.sendMessage("§e[시스템] 권한을 획득하셨습니다.");
                sender.addTag("admin");
                return;
            }
        });

        return;
    }

    if (msg === "!시작") {
        ev.cancel = true;

        system.run(() => {
            if (!sender.hasTag("admin")) {
                sender.sendMessage("§c[시스템] 관리자 권한이 필요합니다.");
                return;
            }

            if (gameRunning) {
                sender.sendMessage("§c[시스템] 이미 게임이 진행 중입니다.");
                return;
            }

            startGame();
        });

        return;
    }
});

// ─── 피해 이벤트 ──────────────────────────────
world.beforeEvents.entityHurt.subscribe((ev) => {
  if (!gameRunning) return;

  const attacker = ev.damageSource?.damagingEntity;
  if (!attacker || attacker.typeId !== "minecraft:player") return;

  const victim = ev.hurtEntity;
  if (!victim || victim.typeId !== "minecraft:player") return;

  if (!attacker.hasTag("player") || !victim.hasTag("player")) return;

  const attackerName = attacker.name;
  const victimName = victim.name;

  const myTarget = targetMap.get(attackerName);

  
  const attackerLeader = getLeaderOf(attackerName);
  const victimLeader = getLeaderOf(victimName);


  if (attackerLeader && attackerLeader === victimLeader) {
    ev.cancel = true;

    system.run(() => {
        attacker.onScreenDisplay.setActionBar(
            `§c⚠ 같은 팀은 공격할 수 없습니다!`
            );
        });

    return;
    }
});


// ─── 패널티 관리 ──────────────────────────────
// { playerName -> intervalId }  (이동 제한 인터벌)
const penaltyIntervals = new Map();
// { playerName + "_loc" -> location }  (고정 위치)

/**
 * 플레이어를 특정 위치에 N틱 동안 고정시키는 패널티
 * @param {Player} player
 * @param {{ x, y, z }} fixedLoc  - 고정할 좌표 (undefined면 현재 위치 사용)
 * @param {number} durationTicks  - 패널티 지속 틱 (기본 600 = 30초)
 * @param {string} reason         - 액션바에 표시할 사유 문자열
 */
function applyMovePenalty(player, fixedLoc, durationTicks = 600, reason = "이동 제한 패널티") {
    const name = player.name;

    // 이미 패널티 중이면 기존 인터벌 제거 후 재시작 (위치 갱신)
    if (penaltyIntervals.has(name)) {
        system.clearRun(penaltyIntervals.get(name));
        penaltyIntervals.delete(name);
    }

    // 고정 위치 결정: 인자로 받은 위치 우선, 없으면 현재 위치
    const loc = fixedLoc ?? player.location;
    penaltyIntervals.set(name + "_loc", loc);

    let tick = 0;
    const id = system.runInterval(() => {
        const p = getPlayerByName(name);
        if (!p) {
            // 오프라인이면 정리
            system.clearRun(penaltyIntervals.get(name));
            penaltyIntervals.delete(name);
            penaltyIntervals.delete(name + "_loc");
            return;
        }

        tick++;
        p.runCommand("spawnpoint @s ~~~");
        p.runCommand("kill @e[r=10,type=!player]");

        const savedLoc = penaltyIntervals.get(name + "_loc") ?? loc;
        try { p.teleport(savedLoc, { dimension: p.dimension }); } catch (_) {}

        const remaining = Math.ceil((durationTicks - tick) / 20);
        p.onScreenDisplay.setActionBar(`§c⛔ ${reason}: §f${remaining}초 남음`);

        if (tick >= durationTicks) {
            system.clearRun(penaltyIntervals.get(name));
            penaltyIntervals.delete(name);
            penaltyIntervals.delete(name + "_loc");
            p.sendMessage("§a[시스템] 패널티가 종료되었습니다. 이동할 수 있습니다.");
        }
    }, 1);

    penaltyIntervals.set(name, id);
}

// ─────────────────────────────────────────────
//  타이머 ID (게임 종료 시 정리용)
// ─────────────────────────────────────────────
let airdropTimerId   = -1;  // 보급 타이머
let revealTimerId    = -1;  // 좌표 공개 타이머
let revealWarnId     = -1;  // 1분 전 경고 타이머

// ─────────────────────────────────────────────
//  보급 타이머 시작  (20분 = 24000틱 간격)
// ─────────────────────────────────────────────
function startAirdropTimer() {
    const AIRDROP_INTERVAL = 2400; // 20분

    // 첫 에어드랍은 20분 뒤
    airdropTimerId = system.runInterval(() => {
        if (!gameRunning) return;
        spawnAirdrop();
    }, AIRDROP_INTERVAL);
}

// ─────────────────────────────────────────────
//  좌표 공개 타이머 시작  (15분 = 18000틱 간격)
//  → 14분 후 경고  →  1분 후 실제 공개
// ─────────────────────────────────────────────
function startRevealTimer() {
    const CYCLE     = 1800; // 15분 (경고 + 공개 합산)
    const WARN_AT   = 600; // 14분 후 경고 (18000 - 1200)

    // 14분마다 경고 메시지
    revealWarnId = system.runInterval(() => {
        if (!gameRunning) return;
        world.sendMessage("§e[좌표 공개] §f1분 뒤 누군가의 좌표가 공개됩니다...");
        world.getDimension("overworld").runCommand("playsound note.bling @a 0 80 0 1 1");
    }, WARN_AT);

    // 15분마다 실제 공개
    revealTimerId = system.runInterval(() => {
        if (!gameRunning) return;

        const targets = getPlayers(); // tag=player 인 플레이어만
        if (targets.length === 0) return;

        const chosen = targets[Math.floor(Math.random() * targets.length)];
        const { x, y, z } = chosen.location;
        const fx = Math.floor(x);
        const fy = Math.floor(y);
        const fz = Math.floor(z);

        world.sendMessage(
            `§c[좌표 공개] §e${chosen.name}§f 의 현재 좌표: §b(${fx}, ${fy}, ${fz})`
        );
        world.getDimension("overworld").runCommand(
            `playsound mob.endermen.portal @a ${fx} ${fy} ${fz} 1 1`
        );
    }, CYCLE);
}

// ─── 사망 이벤트 ──────────────────────────────
world.afterEvents.entityDie.subscribe(ev => {
    if (!gameRunning) return;

    const victim = ev.deadEntity;
    if (!victim || victim.typeId !== "minecraft:player") return;
    if (!victim.hasTag("player")) return;

    const killer = ev.damageSource.damagingEntity;
    const killerIsGamePlayer =
        killer && killer.typeId === "minecraft:player" && killer.hasTag("player");

    const victimName = victim.name;

    // ── 꼬리잡기 처치인지 판별 ──────────────────
    const isTagKill = killerIsGamePlayer && targetMap.get(killer.name) === victimName;

    // ── 팀원(member)인지 판별 ───────────────────
    // teamMap 에는 리더만 key로 있고, 멤버는 Set 안에 있음
    const victimLeaderName = getLeaderOf(victimName);
    const victimIsTeamMember =
        victimLeaderName !== null && victimLeaderName !== victimName;

    // ── 케이스 A: 팀원이 사망 ───────────────────
    if (victimIsTeamMember) {
        const leader = getPlayerByName(victimLeaderName);
        if (leader) {
            // 리더 위치로 부활 후 이동 제한 30초
            system.runTimeout(() => {
                const p = getPlayerByName(victimName);
                if (!p) return;
                const leaderLoc = leader.location;
                try { p.teleport(leaderLoc, { dimension: leader.dimension }); } catch (_) {}
                p.sendMessage(`§c[꼬리잡기] §f${victimLeaderName}§c 위치로 소환됩니다. 30초 이동 제한!`);
                applyMovePenalty(p, leaderLoc, 600, "팀원 사망 패널티");
            }, 40); // 부활 대기(약 2초) 후 실행
        }
        return; // 팀원 사망은 게임 로직(처치/승리) 영향 없음
    }

    // ── 케이스 B: 자기 혼자 사망 (꼬리잡기 처치 아님) ──
    if (!isTagKill) {
        // 이미 패널티 중이면 무시
        if (penaltyIntervals.has(victimName)) return;

        world.sendMessage(`§c[꼬리잡기] §f${victimName}§c 이(가) 혼자 죽었습니다! §e30초 이동 제한 패널티`);

        system.runTimeout(() => {
            const p = getPlayerByName(victimName);
            if (!p) return;
            applyMovePenalty(p, undefined, 600, "자기 사망 패널티");
        }, 40);
        return;
    }

    // ── 케이스 C: 꼬리잡기 정상 처치 ─────────────
    const killerName = killer.name;

    world.sendMessage(`§e[꼬리잡기] §f${killerName}§e 이(가) §f${victimName}§e 을(를) 처치했습니다!`);

    // 팀 흡수 (희생자 + 희생자 팀 전체 → 처치자 팀)
    absorbTeam(killerName, victimName);

    // 희생자를 목표로 삼던 다른 사냥꾼 → 처치자로 목표 변경
    for (const [hunter, prey] of targetMap) {
        if (prey === victimName && hunter !== killerName) {
            targetMap.set(hunter, killerName);
            const hp = getPlayerByName(hunter);
            if (hp) hp.sendMessage(`§b[꼬리잡기] §f목표가 §e${killerName}§f(으)로 변경되었습니다.`);
        }
    }

    // 처치자의 다음 목표 계승
    const nextTarget = targetMap.get(victimName);
    if (nextTarget && nextTarget !== killerName) {
        targetMap.set(killerName, nextTarget);
        const kp = getPlayerByName(killerName);
        if (kp) kp.sendMessage(`§b[꼬리잡기] §f목표가 §e${nextTarget}§f(으)로 변경되었습니다.`);
    } else {
        targetMap.delete(killerName);
    }

    targetMap.delete(victimName);

    // 승리 조건: targetMap에 남은 독립 사냥꾼이 1명 이하
    const activeHunters = [...targetMap.keys()];
    if (activeHunters.length <= 1) {
        const winnerName = activeHunters.length === 1 ? activeHunters[0] : killerName;
        endGame();
        world.sendMessage(`§6[꼬리잡기] §f${winnerName}§6 팀이 우승했습니다! 🏆`);
        const dim = world.getDimension("overworld");

        dim.runCommand(`title @a title §f${winnerName}§6 팀 우승!!`);
        dim.runCommand("playsound mob.enderdragon.growl @a ~~~ 1 1 1");

    }
});

world.beforeEvents.itemUse.subscribe(ev => {
    if (!gameRunning) return;

    const player = ev.source;
    if (!player.hasTag("player")) return;

    const item = ev.itemStack;
    if (!item || item.typeId !== "minecraft:compass") return;

    const now = system.currentTick;
    const cooldownEnd = compassCooldown.get(player.name) ?? 0;

    if (now < cooldownEnd) {
        ev.cancel = true; 
        const remaining = Math.ceil((cooldownEnd - now) / 20);

        player.onScreenDisplay.setActionBar(
            `§c나침반 재사용 대기: §f${remaining}초`
        );
        return;
    }

    const targetName = targetMap.get(player.name);
    if (!targetName) {
        player.onScreenDisplay.setActionBar("§c추적할 대상이 없습니다!");
        return;
    }

    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return;

    let ironCount = 0;
    for (let i = 0; i < inv.size; i++) {
        const slot = inv.getItem(i);
        if (slot && slot.typeId === "minecraft:iron_ingot") {
            ironCount += slot.amount;
        }
    }

    if (ironCount < 10) {
        player.onScreenDisplay.setActionBar("§c철 주괴 10개가 필요합니다!");
        player.runCommand("playsound random.anvil_land @a ~~~ 1 1 1")
        return;
    }

    // 제거
    try {
        player.runCommand("clear @s minecraft:iron_ingot 0 10");
    } catch (e) {
        player.sendMessage("§c아이템 제거 중 오류 발생!");
        return;
    }

    player.runCommand("playsound beacon.activate @a ~~~ 1 1 1")
    player.sendMessage("§c[꼬리잡기] 나침반이 60초간 활성화됩니다!");
    compassActive.set(player.name, now + 1200);
    compassCooldown.set(player.name, now + 1800);
});

const hunterAlerted = new Set();
// 전역 상수


// ─── 메인 루프 (5틱마다) ─────────────────────
system.runInterval(() => {
    if (!gameRunning) return;

    const now = system.currentTick;
    const allPlayers = world.getPlayers();

    // ─── 구역 제한 (±500) ────────────────────
    const BORDER = 500;
    for (const player of allPlayers) {
        if (!player.hasTag("player")) continue;
        const { x, y, z } = player.location;
        let nx = x, nz = z, oob = false;
        if      (x >  BORDER) { nx =  BORDER - 1; oob = true; }
        else if (x < -BORDER) { nx = -BORDER + 1; oob = true; }
        if      (z >  BORDER) { nz =  BORDER - 1; oob = true; }
        else if (z < -BORDER) { nz = -BORDER + 1; oob = true; }
        if (oob) {
            player.teleport({ x: nx, y, z: nz }, { dimension: player.dimension });
            player.onScreenDisplay.setActionBar("§c⚠ 구역 경계를 벗어났습니다!");
        }
    }

    // ─── 항상 현재 위치에 스폰포인트 설정 ───
    for (const player of allPlayers) {
        player.runCommand("spawnpoint @s ~~~");
    }

    // ─── 팀원 거리 이탈 데미지 ───────────────
    // 리더에게서 50블럭 초과 시 지속 데미지
    const LEASH_DIST = 50;
    for (const [leaderName, members] of teamMap) {
        if (members.size === 0) continue;
        const leader = allPlayers.find(p => p.name === leaderName);
        if (!leader) continue;

        for (const memberName of members) {
            // 패널티 중인 팀원은 이미 위치 고정 중이므로 스킵
            if (penaltyIntervals.has(memberName)) continue;

            const member = allPlayers.find(p => p.name === memberName);
            if (!member) continue;

            const dx = member.location.x - leader.location.x;
            const dy = member.location.y - leader.location.y;
            const dz = member.location.z - leader.location.z;
            const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist3d > LEASH_DIST) {
                // 매 5틱(0.25초)마다 1 데미지
                try {
                    member.runCommand("damage @s 1 void");
                } catch (_) {}
                const over = Math.floor(dist3d - LEASH_DIST);
                member.onScreenDisplay.setActionBar(
                    `§c⚠ 핵심 플레이어(§f${leaderName}§c)에서 너무 멀어졌습니다! +${over}m 초과`
                );
            }
        }
    }

    // ─── 접근 감지 ───────────────────────────
    for (const [hunterName, targetName] of targetMap) {
        const hunter = allPlayers.find(p => p.name === hunterName);
        const target = allPlayers.find(p => p.name === targetName);
        if (!hunter || !target) continue;

        const dx = hunter.location.x - target.location.x;
        const dz = hunter.location.z - target.location.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        const alertKey = `${hunterName}->${targetName}`;

        if (dist <= 100) {
            if (!hunterAlerted.has(alertKey)) {
                hunterAlerted.add(alertKey);
                target.onScreenDisplay.setActionBar(`§c⚠ 누군가가 당신을 찾아왔습니다!`);
                target.runCommand(`playsound note.pling @s ~ ~ ~ 1 0.5`);
            }
        } else {
            hunterAlerted.delete(alertKey);
        }
    }

    // ─── 나침반 방향 표시 ─────────────────────
    for (const player of allPlayers) {
        if (!player.hasTag("player")) continue;

        const activeUntil = compassActive.get(player.name) ?? 0;
        if (now >= activeUntil) continue;

        const targetName = targetMap.get(player.name);
        if (!targetName) continue;

        const target = allPlayers.find(p => p.name === targetName);
        if (!target) {
            player.onScreenDisplay.setActionBar(`§7[목표: §f${targetName}§7] (오프라인)`);
            continue;
        }

        const px = player.location.x;
        const pz = player.location.z;
        const tx = target.location.x;
        const tz = target.location.z;
        const dx = tx - px;
        const dz = tz - pz;

        let absoluteAngle = Math.atan2(-dx, dz) * (180 / Math.PI);
        if (absoluteAngle < 0) absoluteAngle += 360;

        let playerYaw = player.getRotation().y;
        let yawConverted = ((playerYaw % 360) + 360) % 360;
        let relativeAngle = ((absoluteAngle - yawConverted) % 360 + 360) % 360;

        let direction;
        if      (relativeAngle >= 337.5 || relativeAngle < 22.5)  direction = "↑";
        else if (relativeAngle < 67.5)                             direction = "↗";
        else if (relativeAngle < 112.5)                            direction = "→";
        else if (relativeAngle < 157.5)                            direction = "↘";
        else if (relativeAngle < 202.5)                            direction = "↓";
        else if (relativeAngle < 247.5)                            direction = "↙";
        else if (relativeAngle < 292.5)                            direction = "←";
        else                                                       direction = "↖";

        const dist = Math.sqrt(dx * dx + dz * dz).toFixed(1);
        const remaining = Math.ceil((activeUntil - now) / 20);

        player.onScreenDisplay.setActionBar(
            `§e${targetName} §f| ${direction} | §b${dist}m §7(${remaining}초)`
        );
    }

}, 5);

// ─── 게임 종료 ────────────────────────────────
function endGame() {
    gameRunning = false;
    targetMap.clear();
    teamMap.clear();
    compassCooldown.clear();
    compassActive.clear();

    // 패널티 인터벌 전체 정리
    for (const [key, id] of penaltyIntervals) {
        if (typeof id === "number") system.clearRun(id);
    }
    penaltyIntervals.clear();

    // 효과 제거 및 태그 초기화
    world.getDimension("overworld").runCommand("effect @a[tag=player] clear");
    world.getDimension("overworld").runCommand("tag @a remove player");

    world.sendMessage("§a[꼬리잡기] §f게임이 종료되었습니다. '!참가'를 입력해 다시 참가할 수 있습니다.");
}