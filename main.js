import { world, system } from "@minecraft/server";

//  ---------------------------------------------
//  설정
//  ---------------------------------------------
const SCOREBOARD_NAME = "team";          // scoreboard 이름
const DEFAULT_TEAMS   = 3;              // 기본 팀 수
const CMD_ADD_TEAM    = "!추가";        // 팀 추가 명령어
const CMD_LIST        = "!팀목록";      // 팀 목록 확인 명령어
const CMD_ASSIGN      = "!팀배정";      // 팀 자동 배정 명령어
const CMD_SET         = "!팀설정";      // 수동 팀 설정 ex) !팀설정 2
const CMD_RESET       = "!팀초기화";    // 전체 초기화 명령어
const CMD_HELP        = "!팀도움말";    // 도움말
const CMD_TEAM_CHAT   = "!팀채팅";      // 팀 채팅 모드 토글

/**
 * 팀 번호 → 색상 코드 + 이름
 * scoreboard belowname 은 §색코드 를 지원합니다.
 * 팀이 늘어나면 TEAM_COLORS 배열을 순환합니다.
 * 고맙다 피티피티야.
 */
const TEAM_COLORS = [
  { code: "§c", name: "§c빨강팀" },   // 0 → 빨강
  { code: "§9", name: "§9파랑팀" },   // 1 → 파랑
  { code: "§a", name: "§a초록팀" },   // 2 → 초록
  { code: "§e", name: "§e노랑팀" },   // 3 → 노랑
  { code: "§5", name: "§5보라팀" },   // 4 → 보라
  { code: "§6", name: "§6주황팀" },   // 5 → 주황
  { code: "§b", name: "§b하늘팀" },   // 6 → 하늘
  { code: "§d", name: "§d분홍팀" },   // 7 → 분홍
  { code: "§f", name: "§f흰색팀" },   // 8 → 흰색
  { code: "§8", name: "§8회색팀" },   // 9 → 회색
];

// ---------------------------------------------
//  내부 상태
// ---------------------------------------------
let totalTeams = DEFAULT_TEAMS;  // 현재 팀 수
let teamObjective = null;         // scoreboard objective (team)

// 팀 채팅 모드 활성화 플레이어 이름 Set
const teamChatMode = new Set();

// ---------------------------------------------
//  유틸 함수
// ---------------------------------------------

/** 팀 번호(0-based)의 색상 정보 반환 */
function getTeamColor(teamNum) {
  return TEAM_COLORS[teamNum % TEAM_COLORS.length];
}

/** 플레이어의 팀 번호 반환 (없으면 -1) */
function getPlayerTeam(player) {
  try {
    const score = teamObjective.getScore(player);
    if (score === undefined || score === null) return -1;
    // 0은 "미배정", 1~N 이 팀 번호로 쓰임
    return score - 1; // score 1 = 팀0, score 2 = 팀1, ...
  } catch {
    return -1;
  }
}

/** 플레이어에 팀 설정 (teamNum은 0-based) */
function setPlayerTeam(player, teamNum) {
  teamObjective.setScore(player, teamNum + 1); // 팀0 = 1점
  updateNameTag(player, teamNum);
}

/** 플레이어 nameTag 갱신 (팀 접두사 + 원래 이름) */
function updateNameTag(player, teamNum) {
  if (teamNum < 0) {
    // 팀 없음 → 원본 이름 복원
    player.nameTag = player.name;
  } else {
    const col = getTeamColor(teamNum);
    player.nameTag = `${col.code}[${col.name.replace(/§[0-9a-fA-Fk-or]/g, "")}]§r ${player.name}`;
  }
}

/** 전체 플레이어 nameTag 갱신 */
function refreshAllNameTags() {
  for (const player of world.getAllPlayers()) {
    const t = getPlayerTeam(player);
    updateNameTag(player, t);
  }
}

/** 팀에 속한 플레이어 수 반환 */
function countPlayersInTeam(teamNum) {
  let count = 0;
  for (const player of world.getAllPlayers()) {
    if (getPlayerTeam(player) === teamNum) count++;
  }
  return count;
}

/** 플레이어 수가 가장 적은 팀 번호 반환 (자동 배정용) */
function getLeastPopulatedTeam() {
  let minCount = Infinity;
  let minTeam = 0;
  for (let i = 0; i < totalTeams; i++) {
    const c = countPlayersInTeam(i);
    if (c < minCount) {
      minCount = c;
      minTeam = i;
    }
  }
  return minTeam;
}

/** 팀 목록 메시지 생성 */
function buildTeamListMessage() {
  let msg = "§l=== 팀 목록 ===§r\n";
  for (let i = 0; i < totalTeams; i++) {
    const col = getTeamColor(i);
    const count = countPlayersInTeam(i);
    const members = [];
    for (const player of world.getAllPlayers()) {
      if (getPlayerTeam(player) === i) members.push(player.name);
    }
    msg += `${col.name} §7(${count}명)`;
    if (members.length > 0) {
      msg += `§7: ${members.join(", ")}`;
    }
    msg += "\n";
  }
  msg += `§7총 ${totalTeams}개 팀`;
  return msg.trim();
}

//  ---------------------------------------------
//  scoreboard 초기화
//  ---------------------------------------------
function initScoreboards() {
  // team objective
  try {
    teamObjective = world.scoreboard.getObjective(SCOREBOARD_NAME);
    if (!teamObjective) {
      teamObjective = world.scoreboard.addObjective(SCOREBOARD_NAME, "팀");
    }
  } catch {
    teamObjective = world.scoreboard.addObjective(SCOREBOARD_NAME, "팀");
  }

  // 기존 팀 데이터가 있는 플레이어의 nameTag 복원
  refreshAllNameTags();
}

//  ---------------------------------------------
//  채팅 명령어 처리
//  ---------------------------------------------
world.beforeEvents.chatSend.subscribe((ev) => {
  const msg = ev.message.trim();
  const player = ev.sender;

  // -- !팀채팅 (토글)  ------------------------
  if (msg === CMD_TEAM_CHAT) {
    ev.cancel = true;
    const name = player.name;
    const nowActive = !teamChatMode.has(name);
    if (nowActive) {
      const myTeam = getPlayerTeam(player);
      if (myTeam < 0) {
        system.run(() => {
          player.sendMessage("§c[팀채팅] 팀에 배정된 후 사용할 수 있습니다.");
        });
        return;
      }
      teamChatMode.add(name);
      const col = getTeamColor(myTeam);
      system.run(() => {
        player.sendMessage(`§l[팀채팅] §a활성화§r — ${col.name}§r 팀원에게만 메시지가 전달됩니다.`);
        player.sendMessage(`§l[팀채팅] 다시 한번 §e'!팀채팅'§r을 입력하면 일반 채팅 상태로 돌아갑니다.`);
      });
    } else {
      teamChatMode.delete(name);
      system.run(() => {
        player.sendMessage("§l[팀채팅] §c비활성화§r — 일반 채팅으로 돌아왔습니다.");
      });
    }
    return;
  }

  // -- 팀 채팅 모드 메시지 가로채기----------
  if (teamChatMode.has(player.name)) {
    ev.cancel = true;
    const senderTeam = getPlayerTeam(player);
    if (senderTeam < 0) {
      // 팀이 사라진 경우 모드 해제
      teamChatMode.delete(player.name);
      system.run(() => {
        player.sendMessage("§c[팀채팅] 팀 정보가 없어 팀 채팅이 해제되었습니다.");
      });
      return;
    }
    const col = getTeamColor(senderTeam);
    // 팀채팅 접두사 포함 메시지
    const formatted = `${col.code}[팀채팅] ${player.name}§r: §7${msg}`;
    system.run(() => {
      for (const p of world.getAllPlayers()) {
        if (getPlayerTeam(p) === senderTeam) {
          p.sendMessage(formatted);
        }
      }
    });
    return;
  }

  // -- !추가 ---------------------------------
  if (msg === CMD_ADD_TEAM) {
    ev.cancel = true;
    totalTeams++;
    const col = getTeamColor(totalTeams - 1);
    system.run(() => {
      world.sendMessage(
        `§l[시스템]§r ${col.name}§r 이(가) 추가되었습니다! §7(총 ${totalTeams}개 팀)`
      );
    });
    return;
  }

  // -- !팀목록 ---------------------------------
  if (msg === CMD_LIST) {
    ev.cancel = true;
    system.run(() => {
      player.sendMessage(buildTeamListMessage());
    });
    return;
  }

  // -- !팀배정 ---------------------------------
  if (msg === CMD_ASSIGN) {
    ev.cancel = true;
    system.run(() => {
      const assigned = getLeastPopulatedTeam();
      setPlayerTeam(player, assigned);
      const col = getTeamColor(assigned);
      player.sendMessage(`§l[시스템]§r ${col.name}§r 에 배정되었습니다!`);
      world.sendMessage(`§7${player.name}§r 님이 ${col.name}§r 에 합류했습니다.`);
    });
    return;
  }

  // -- !팀설정 <번호> --------------------------
  if (msg.startsWith(CMD_SET)) {
    ev.cancel = true;
    const parts = msg.split(" ");
    const num = parseInt(parts[1]);
    system.run(() => {
      if (isNaN(num) || num < 1 || num > totalTeams) {
        player.sendMessage(`§c1 ~ ${totalTeams} 사이의 숫자를 입력하세요. 예) ${CMD_SET} 1`);
        return;
      }
      const teamNum = num - 1;
      setPlayerTeam(player, teamNum);
      const col = getTeamColor(teamNum);
      player.sendMessage(`§l[시스템]§r ${col.name}§r 으로 설정되었습니다!`);
      world.sendMessage(`§7${player.name}§r 님이 ${col.name}§r 으로 이동했습니다.`);
    });
    return;
  }

  // -- !팀초기화 -------------------------------
  if (msg === CMD_RESET) {
    ev.cancel = true;
    system.run(() => {
      for (const p of world.getAllPlayers()) {
        try { teamObjective.removeParticipant(p); } catch { /* ignore */ }
        teamChatMode.delete(p.name);
        p.nameTag = p.name; // 닉네임 원상 복구
      }
      totalTeams = DEFAULT_TEAMS;
      world.sendMessage(`§l[시스템]§r §c모든 팀이 초기화되었습니다. §7(기본 ${DEFAULT_TEAMS}팀)`);
    });
    return;
  }

  // -- !팀도움말 -------------------------------
  if (msg === CMD_HELP) {
    ev.cancel = true;
    system.run(() => {
      player.sendMessage(
        "§l=== 팀 시스템 명령어 ===§r\n" +
        `§e${CMD_ADD_TEAM}§r - 팀 1개 추가 (현재 ${totalTeams}개)\n` +
        `§e${CMD_ASSIGN}§r - 인원 적은 팀에 자동 배정\n` +
        `§e${CMD_SET} <번호>§r - 특정 팀으로 이동 (1~${totalTeams})\n` +
        `§e${CMD_LIST}§r - 팀 목록 및 인원 확인\n` +
        `§e${CMD_TEAM_CHAT}§r - 팀 채팅 모드 토글 (팀원끼리만 보임)\n` +
        `§e${CMD_RESET}§r - 전체 초기화\n` +
        `§e${CMD_HELP}§r - 이 도움말`
      );
    });
    return;
  }
});

// ---------------------------------------------
//  같은 팀 공격 방지
// ---------------------------------------------
world.beforeEvents.entityHurt.subscribe((ev) => {
  const attacker = ev.damageSource?.damagingEntity;
  if (!attacker || attacker.typeId !== "minecraft:player") return;

  const victim = ev.hurtEntity;
  if (!victim || victim.typeId !== "minecraft:player") return;

  const attackerTeam = getPlayerTeam(attacker);
  const victimTeam   = getPlayerTeam(victim);

  if (attackerTeam < 0 || victimTeam < 0) return;

  // 같은 팀 데미지 무효화
  if (attackerTeam === victimTeam) {
    ev.cancel = true;
    const col = getTeamColor(attackerTeam);
    system.run(() => {
      attacker.sendMessage(`§c[시스템] 같은 ${col.name}§c 팀원을 공격할 수 없습니다!`);
    });
  }
});

// ---------------------------------------------
//  플레이어 입장 시 안내 + nameTag 복원
// ---------------------------------------------
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  const player = ev.player;

  system.runTimeout(() => {
    const t = getPlayerTeam(player);
    if (t < 0) {
      player.sendMessage(
        "§l[시스템]§r 환영합니다!\n" +
        `§e${CMD_ASSIGN}§r 으로 자동 팀 배정, §e${CMD_HELP}§r 으로 명령어 확인`
      );
    } else {
      updateNameTag(player, t); // 재접속 시 nameTag 복원
      const col = getTeamColor(t);
      player.sendMessage(`§l[시스템]§r 현재 ${col.name}§r 소속입니다.`);
      player.sendMessage(`§e${CMD_HELP}§r 으로 명령어 확인이 가능합니다.`);
    }
  }, 40);
});

// ---------------------------------------------
//  플레이어 퇴장 시 팀 채팅 모드 정리
// ---------------------------------------------
world.afterEvents.playerLeave.subscribe((ev) => {
  teamChatMode.delete(ev.playerName);
});

// ---------------------------------------------
//  월드 로드 시 scoreboard 초기화
// ---------------------------------------------
system.run(() => {
  initScoreboards();
  console.log("[시스템] 초기화 완료 - 기본 팀 수:", DEFAULT_TEAMS);
});
