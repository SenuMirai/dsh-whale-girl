#!/usr/bin/env node
import { createReadStream, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { downloadArtifact } from "@electron/get";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";

//#region src/host/config.ts
/** 位置角落白名单 */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const CORNER_SET = new Set(CORNERS);
/** display 白名单（导出：宿主路由 POST /pet-display 写单只宠物的显示位置时复用同一份枚举，
*  读写两侧必须同一份规则，不在路由里另写一个 Set） */
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const PET_DISPLAY_SET = new Set(PET_DISPLAYS);
/** font.family 白名单（预设 id）——**必须与 src/shared/fonts.ts 的 FONT_PRESETS 保持一致**：
*  host 不能 import src/shared（见文件头注释的 DSH 单文件加载约束），这里是那份清单的自包含副本，
*  所以加/删字体预设时两边都要改。 */
const FONT_FAMILY_SET = new Set([
	"candy",
	"yahei",
	"youyuan",
	"kaiti",
	"simsun",
	"comic",
	"system"
]);
/** font.size 合法区间（px，含端点）——与 src/shared/fonts.ts 的 FONT_SIZE_MIN / FONT_SIZE_MAX 同一口径 */
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/**
* 「全局默认 + 种类可覆盖」的顶层字段白名单 —— 用户层（main-config.jsonc）里写下的值会成为
* **所有条目**的默认值；种类文件 `pet/<名>-config.json` 仍可在自己顶层覆盖（写了就用自己那份）。
*
* 判据：这几个是**用户级「成本 / 偏好 / 环境 / 节奏」参数**，不是「这个种类长什么样」——
*   - `chatMemoryRounds`：带多少历史进上下文 = token 成本
*   - `whisperModel` / `chatModel`：碎碎念 / 对话用哪个模型 = 成本与能力偏好
*   - `whisperImageEnabled` / `chatImageEnabled`：要不要把表情包清单附进请求 = token 成本
*   - `chatImageLimit`：对话那张清单**最多几张**——同属 token 成本（清单每条消息都附）
*   - `eventsRefreshSec`：多久调一次模型 / 拉一次余额 = 成本与节奏。注意它内部两个键的**消费端**
*     不同：`.whisper` 按宠物所属条目读（种类可覆盖）；`.balance` 只读 main 条目
*     （余额数据一份 + host 只有一个定时器，架构上给不了每种类一个周期）
*   - `physics`：拖拽抛掷手感；`petCollision` 更是**跨宠物**行为（相撞按动量守恒弹开），
*     按种类分在语义上站不住：两只不同种类的宠物相撞时用谁的系数？
*   - `confineToScreen`：多屏是用户环境 / 使用习惯，不是宠物属性
*   - `font`：字体种类 / 字号 / 是否随宠物缩放是**看的人**的偏好，不是某个种类的属性——
*     同一套字体偏好用在所有宠物（含 pet pack）才符合预期
*
* 不在名单里的顶层字段基座仍是**内置默认**：`whisperPrompt`（人设）、`memes`（表情包）、
* `animations` / `animationWeights`（与素材根绑定）、`workStatusTexts`（文案）——一个种类一份
* 动画池 / 一份人设 / 一个表情包目录，各写一份才是 pet pack 的意义。
*/
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"font",
	"confineToScreen",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn("dsh-whale-girl: " + message);
}
/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON */
function stripJsonc(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
}
/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return void 0;
	}
}
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
*  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
	return void 0;
}
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name) => /^.+?-config\.(json|jsonc)$/.test(name)).sort().map((name) => ({
		prefix: name.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name)
	}));
}
function readPetConfigEntry(paths, entry) {
	const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
	return hit ? {
		path: hit.path,
		raw: readJsonc(hit.path)
	} : void 0;
}
function configVersion(paths) {
	let max = 0;
	const bump = (file) => {
		if (!file) return;
		try {
			const st = statSync(file);
			if (st.mtimeMs > max) max = st.mtimeMs;
		} catch {}
	};
	bump(paths.userFile);
	bump(paths.legacyUserFile);
	for (const file of scanPetFiles(paths.petDir)) bump(file.path);
	return String(max);
}
/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool of Object.values(evEntries)) {
		if (!Array.isArray(pool) || pool.length === 0) return false;
		for (const slot of pool) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name of slot) if (typeof name !== "string" || name.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	return Array.isArray(balance) && balance.length > 0;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
*  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
/** font 段校验：family ∈ 预设白名单、size 为区间内的有限数字、followPet 为布尔。
*  与 physics 同口径：**整段校验**——任一子键缺失/非法即整段非法（告警 + 取默认），
*  不做「缺子键逐个补默认」；对象字段一律整段替换（见文件头合并规则）。 */
function fontValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const f = value;
	if (typeof f.family !== "string" || !FONT_FAMILY_SET.has(f.family)) return false;
	const size = Number(f.size);
	if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
	return typeof f.followPet === "boolean";
}
/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
*  **要么都留空（= 跟随当前对话的模型）要么都非空**——只填一半（选了服务商没选模型，或反之）
*  会拼出"用 A 家的模型名去问 B 家"这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "chatImageEnabled": return typeof value === "boolean";
		case "confineToScreen": return typeof value === "boolean";
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "font": return fontValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
*
* 只校验「写下的每个值都合法」，**不**要求键集合与内置默认一致——这个字段和别的顶层字段
* 一样是**整段替换**：缺的键就是缺（消费端各自兜底 1800 / 300），多写的键原样保留
* （不再像旧的逐键深合并那样静默丢弃不认识的键）。空对象合法（等于全走消费端兜底）。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}
/**
* 文件宠物条目的合并基座：内置默认 + 白名单字段改用**用户层**的值。
*
* 为什么：那 9 个字段是用户级成本/偏好/环境/节奏参数，不是种类属性——用户在设置页改一次，
* 期望所有宠物（含 pet pack）都生效。没有这一步，文件宠物只能拿到内置默认值，
* 于是"设置页写着全局、实际只影响主宠物"（见 GLOBAL_DEFAULT_KEYS 的判据）。
*
* 语义仍是「种类可覆盖」：种类文件顶层写了自己的值 → 走 overlay 覆盖（mergeEntry 负责）。
* 用户层写了但非法的值直接跳过（main 条目那边合并时已告警过一次，这里不再重复刷屏）。
*/
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own = mainOverlay[key];
		if (own === void 0 || !topFieldValid(key, own)) continue;
		out ??= { ...base };
		out[key] = own;
	}
	return out ?? base;
}
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		const own = overlay ? overlay[key] : void 0;
		if (own === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own, def, min, label, field, id) {
	const n = Number(own);
	if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own, def, label, field, id) {
	if (typeof own === "boolean") return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own, set, def, label, field, id) {
	if (typeof own === "string" && set.has(own)) return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		}
	};
}
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-whale-girl: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		const found = pets.find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
	return void 0;
}
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = String(pp.id ?? "");
		if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		let name = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name) {
			console.warn(`dsh-whale-girl: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		out.push({
			id,
			name,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		});
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const fo = o.font;
	if (fo !== void 0 && !fontValid(fo)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (ph !== void 0) outConfig.physics = ph;
	if (fo !== void 0) outConfig.font = fo;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (ph !== void 0) bodyOwned.add("physics");
	if (fo !== void 0) bodyOwned.add("font");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}

//#endregion
//#region src/host/helper-process.ts
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
const BRIDGE_PREFIX = "dsh-whale-girl-bridge:";
function resolveElectronPath(candidates = []) {
	const seen = new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_WHALE_ELECTRON_PATH) push(process.env.DSH_WHALE_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find((value) => existsSync(value));
}
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_WHALE_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_WHALE_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_WHALE_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (existsSync(exe)) return exe;
	const log = (message) => console.log(`[dsh-whale-girl] ${message}`);
	const warn = (message) => console.warn(`[dsh-whale-girl] ${message}`);
	const startedAt = Date.now();
	log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
	try {
		mkdirSync(targetDir, { recursive: true });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						log(`downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`);
					}
				}
			});
			const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
			const { default: extract } = await import("@electron-internal/extract-zip");
			await extract(zipPath, { dir: targetDir });
			if (!existsSync(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
			const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`ready in ${readySeconds}s: ${exe}`);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
		warn("desktop pet unavailable. Set DSH_WHALE_ELECTRON_PATH to an existing Electron, or retry later.");
		return void 0;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-whale-girl: cannot resolve Electron executable. Set DSH_WHALE_ELECTRON_PATH or install electron.");
	const helperPath = options.helperPath || defaultHelperMain;
	return {
		command: electronPath,
		args: [helperPath]
	};
}
const HELPER_STOP_TIMEOUT_MS = 3e3;
const HELPER_STOP_GRACE_MS = 1e3;
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_WHALE_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
	}
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const args = this.options.args || launch.args;
		const cwd = this.options.cwd || dshHomeDir();
		mkdirSync(cwd, { recursive: true });
		const child = spawn(command, args, {
			cwd,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-whale-girl desktop helper failed to start: ${error.message}`);
			if (child.pid === void 0 && this.child === child) {
				this.child = void 0;
				this.scheduleRestart();
			}
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (!this.stopping) {
				this.logger.warn?.(`dsh-whale-girl desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-whale-girl desktop helper] ${line}`);
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-whale-girl-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith(BRIDGE_PREFIX)) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-whale-girl desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		const child = this.child;
		if (!child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
		} catch {
			this.logger.warn?.("[dsh-whale-girl desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
	*  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
	*  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-whale-girl desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
	* 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
	* 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
	*   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
	*   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
	*   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
	*      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-whale-girl desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-whale-girl desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_WHALE_RESTART_MAX_FAILURES to raise the limit.`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-whale-girl desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_WHALE_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_WHALE_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_WHALE_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_WHALE_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};
/**
* 等子进程真正退出（issue #64 的"停止要等干净"那一步）：
*   - 已经退出（exitCode/signalCode 有值）→ 立即 resolve，不挂监听；
*   - 只等 `exit`：`close` 只代表 stdio 管道关闭，远早于进程真正退出；
*   - 到 timeoutMs 调 onTimeout()（调用方升级 SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；
*   - 宽限到点仍未退出就 resolve——调用方（配置保存触发的重启）绝不能被无限挂住。
*/
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve$1) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve$1();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}
const HELPER_STABLE_MS = 3 * 60 * 1e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_WHALE_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;
/** 熔断阈值（连续崩溃次数）：默认 12，DSH_WHALE_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;
/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

//#endregion
//#region src/standalone/shims/dsh-credentials.ts
function credentialRef(ref) {
	return ref;
}

//#endregion
//#region src/host/balance/internal.ts
/**
* 余额查询的**内部工具**（host 侧）：网络策略 + 响应校验 + 金额处理。
*
* 只给 ./providers/* 用。所有服务商共用同一套口径：
* - 网络：20s 超时 + 3 次重试（实测该环境对境外端点间歇性超时）；
* - 校验：必填字段缺失/非法一律 `throw`，**绝不静默当 0**（失败要显式暴露成 fetch-error）；
* - 可选字段：缺失就是缺失（`undefined`），不补默认值。
*/
/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;
/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-whale-girl-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-whale-girl: 余额数据非法字段 " + what);
	return n;
}
function str(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-whale-girl: 余额数据非法字段 " + what);
	return value;
}
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 重置时间：字符串原样（ISO 8601）；数字时间戳按秒/毫秒自动识别转 ISO；0 / 负数 / 非法 → undefined。
* 真实报文里空闲窗口是 `resetAt: 0`（占位值，不是 1970 年重置）→ 视为「无重置时间」。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 1e12 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
	const raw = str(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-whale-girl: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

//#endregion
//#region src/host/balance/providers/commandcode.ts
/** 控制面基址（`/alpha/*` 固定在根域名） */
const API_BASE = "https://api.commandcode.ai";
/** 滚动窗时长（展示名）：本服务商的 5h 窗口就是 `windowLimits.fiveHour` */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-whale-girl: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-whale-girl: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const summary = obj(summaryBody);
	const spentRaw = summary?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-whale-girl: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool = spent + remaining;
	const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
	if (pool > 0) data.monthlyCapUsd = pool;
	const subscription = obj(obj(subscriptionBody)?.data);
	const periodEnd = subscription?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	ids: ["commandcode"],
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const whoami = obj(await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"));
		const org = obj(whoami?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson(API_BASE + "/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson(API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
		const summary = await fetchJson(API_BASE + "/alpha/usage/summary" + queryString({
			since: typeof periodStart === "string" ? periodStart : void 0,
			orgId
		}), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};

//#endregion
//#region src/host/balance/deepseek-common.ts
const DEEPSEEK_FULL_BALANCE = "20";
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

//#endregion
//#region src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-whale-girl: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-whale-girl: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-whale-girl: 账号没有充值钱包余额");
	const first = obj(wallets[0]);
	if (!first) throw new Error("dsh-whale-girl: 账号钱包结构非法");
	const currency = typeof first.currency === "string" && first.currency.length > 0 ? first.currency : "CNY";
	const toppedUp = money(first.balance, "balance");
	const bonus = (Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []).map((w) => obj(w)).find((w) => w !== void 0 && w.currency === currency);
	const granted = bonus ? money(bonus.balance, "bonus balance") : "0.00";
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			fullBalance: DEEPSEEK_FULL_BALANCE,
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	ids: ["deepseek-account"],
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-whale-girl: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};

//#endregion
//#region src/host/balance/providers/deepseek-official.ts
const deepseekOfficial = {
	ids: ["deepseek-official"],
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const body = await res.json();
		const infos = body?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-whale-girl: deepseek balance 响应缺少 balance_infos");
		const first = infos[0];
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				currency: str(first.currency, "currency"),
				total: str(first.total_balance, "total_balance"),
				granted: str(first.granted_balance, "granted_balance"),
				toppedUp: str(first.topped_up_balance, "topped_up_balance"),
				fullBalance: DEEPSEEK_FULL_BALANCE,
				tier: deepseekPricingTier()
			}
		};
	}
};

//#endregion
//#region src/host/balance/providers/opencode-go.ts
/** 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗时长（展示名）：本服务商是 5 小时 */
const ROLLING_LABEL = "5h";
const opencodeGo = {
	ids: ["opencode-go"],
	credential: {
		mode: "ref",
		ref: "OPENCODE_GO_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
		if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
		const body = await res.json();
		const usage = body?.usage;
		if (!usage || typeof usage !== "object") throw new Error("dsh-whale-girl: opencode usage 响应缺少 usage");
		const u = usage;
		const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
		if (!rolling || !weekly || !monthly) throw new Error("dsh-whale-girl: opencode usage 响应缺少窗口");
		return {
			ok: true,
			provider,
			shape: "windows",
			data: {
				rolling: num(rolling.percent, "rolling.percent"),
				weekly: num(weekly.percent, "weekly.percent"),
				monthly: num(monthly.percent, "monthly.percent"),
				rollingCapUsd: QUOTA_USD.rolling,
				weeklyCapUsd: QUOTA_USD.weekly,
				monthlyCapUsd: QUOTA_USD.monthly,
				rollingLabel: ROLLING_LABEL,
				rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
				weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
				monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
			}
		};
	}
};

//#endregion
//#region src/host/balance/index.ts
const BALANCE_PROVIDERS = [
	opencodeGo,
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
function matchBalanceProvider(provider) {
	return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}
/**
* 失败结果（三种 reason 一个出口，避免各处手写字段）。
* `message` 缺省时**不写这个键** —— 叶子的形状是对外契约，多一个 `undefined` 键会让
* `deepStrictEqual` 一类的严格比对失败（消费端也按「有/无」判断）。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
async function queryBalance(provider, resolveKey$1, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey$1(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
	}
}

//#endregion
//#region src/standalone/shims/dsh-llm.ts
function createUserMessage(input) {
	return {
		role: "user",
		content: input.content,
		source: input.source
	};
}
function createAssistantMessage(input) {
	return {
		role: "assistant",
		content: input.content,
		source: input.source
	};
}
var BlockAssembler = class {
	chunks = [];
	/** 收集一个块；非文本块（工具调用等）在独立模式下被忽略 */
	push(chunk) {
		if (chunk !== null && typeof chunk === "object" && chunk.type === "text") {
			const text = chunk.text;
			if (typeof text === "string") this.chunks.push(text);
		}
	}
	/** 当前已拼装的块列表 */
	blocks() {
		const text = this.chunks.join("");
		return text === "" ? [] : [{
			type: "text",
			text
		}];
	}
};
function ReasoningEffortId(id) {
	return id;
}

//#endregion
//#region src/host/llm-call.ts
const PET_CALL_IDENTITY = "dsh-whale-girl";
function noTextReason(finish) {
	const { kind, failure } = finish ?? {};
	if (kind === "aborted") return "生成已取消";
	if (kind === "max-tokens") return "输出达到上限，未产出正文";
	if (kind !== "error") return "模型未返回文本";
	const { message, code } = failure ?? {};
	if (typeof message === "string" && message.trim() !== "") return message;
	if (typeof code === "string" && code.trim() !== "") return code;
	return "未提供失败原因";
}

//#endregion
//#region src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/model-selection.ts
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return void 0;
	}
}
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
function modelLabel(m) {
	return m.provider + "/" + m.model;
}

//#endregion
//#region src/host/whisper.ts
/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS$3 = 3e4;
/** 碎碎念指令：纯文本（原行为） */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/**
* 碎碎念指令：带表情包（用户开启 whisperImageEnabled 时）——要求模型配合作画说一句。
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
async function generateWhisper(ctx, system, meme, preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, llm, sel, system, meme);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-whale-girl: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith$1(ctx, llm, sel, system, meme) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS$3);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: meme ? userTextWithMeme(meme) : USER_TEXT
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	return meme ? {
		ok: true,
		text,
		image: meme.name
	} : {
		ok: true,
		text
	};
}

//#endregion
//#region src/host/memes.ts
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name + ".png")))) continue;
		out.push({
			name,
			desc: text
		});
	}
	return out;
}
function pickMeme(pool, random = Math.random) {
	if (pool.length === 0) return void 0;
	const idx = Math.floor(random() * pool.length) % pool.length;
	return pool[idx];
}
function matchMeme(pool, name) {
	const key = String(name ?? "").trim();
	return key ? pool.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白） */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
function memeCatalog(pool) {
	return pool.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
function limitPool(pool, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool;
	return pool.slice(0, n);
}

//#endregion
//#region src/host/chat.ts
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS$2 = 6e4;
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守） */
function imageInstruction(pool) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
async function generateChat(ctx, system, history, userText, pool = [], preferred, images) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, system, history, userText, pool, images);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-whale-girl: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(ctx, llm, sel, system, history, userText, pool, images) {
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS$2);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool.length > 0;
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [...historyMessages, createUserMessage({
			content: [...(images ?? []).map((img) => ({
				type: "image",
				attachment: img
			})), {
				type: "text",
				text: wantImage ? userText + imageInstruction(pool) : userText
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	if (!wantImage) return {
		ok: true,
		text
	};
	const picked = extractChatImage(text, pool);
	return picked.image ? {
		ok: true,
		text: picked.text,
		image: picked.image
	} : {
		ok: true,
		text: picked.text
	};
}

//#endregion
//#region src/host/broadcast.ts
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
function decideBroadcast(args) {
	const { cfg, requested, active, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	if (!rawImage) return {
		ok: true,
		petId,
		text
	};
	const found = findPetInstance(cfg, petId);
	const conf = found ? found.conf : cfg.main ?? {};
	const hit = matchMeme(readMemePool(conf.memes, memeDirs(found ? found.entry : "main")), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name
	};
}

//#endregion
//#region src/host/anim.ts
/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings(a.idle));
	push(strings(a.turn));
	push(strings(a.drag));
	push(strings(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool = events[key];
		if (!Array.isArray(pool)) continue;
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...strings(slot));
		push(names);
	}
	return out;
}
function decideAnim(args) {
	const { cfg, requested, active } = args;
	const name = typeof args.name === "string" ? args.name.trim() : "";
	if (!name) return {
		ok: false,
		reason: "bad-request",
		message: "name 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
	const allowed = animationNames(conf.animations);
	if (!allowed.includes(name)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name
	};
	return {
		ok: true,
		petId,
		name
	};
}

//#endregion
//#region src/host/voice.ts
const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
const DEFAULT_RATE = "+0%";
const DEFAULT_GATEWAY_ENDPOINT = "http://127.0.0.1:50123";
/** 单次合成超时：热调用约 1 秒，给足 25 秒余量兜卡死 */
const TTS_TIMEOUT_MS = 25e3;
/** ASR 超时：本地模型冷启动最慢几秒，给足余量 */
const ASR_TIMEOUT_MS = 6e4;
/**
* 常驻 worker 的 Python 源码。
*
* 协议（stdin/stdout，二进制）：
*   请求  = uint32 BE 长度 + UTF-8 JSON {text, voice, rate, pitch, volume}
*   响应  = uint8 状态（0 = 成功音频，1 = 错误文本）+ uint32 BE 长度 + 载荷
*
* 用定长前缀而不是行分隔：MP3 是二进制，任何分隔符都可能出现在音频里。
*
* pitch / volume 是后加的（QQ 群唱歌与「换个调说话」要用），**空串表示不传**：
* edge-tts 对不认的参数会直接抛 TypeError，老版本 edge-tts 上没有这两个关键字，
* 所以带条件拼 kwargs，而不是一股脑塞进去。
*/
const TTS_WORKER_SCRIPT = String.raw`
import asyncio
import json
import struct
import sys

import edge_tts

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_RATE = "+0%"


async def synth(text: str, voice: str, rate: str, pitch: str, volume: str) -> bytes:
    out = bytearray()
    kwargs = {"rate": rate}
    if pitch:
        kwargs["pitch"] = pitch
    if volume:
        kwargs["volume"] = volume
    communicate = edge_tts.Communicate(text, voice, **kwargs)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            out.extend(chunk["data"])
    return bytes(out)


def read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    return data if data is not None else b""


def main() -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        head = read_exact(stdin, 4)
        if len(head) < 4:
            return 0
        (length,) = struct.unpack(">I", head)
        payload = read_exact(stdin, length)
        if len(payload) < length:
            return 0
        try:
            request = json.loads(payload.decode("utf-8"))
            text = str(request.get("text") or "")
            voice = str(request.get("voice") or DEFAULT_VOICE)
            rate = str(request.get("rate") or DEFAULT_RATE)
            pitch = str(request.get("pitch") or "")
            volume = str(request.get("volume") or "")
            if not text.strip():
                raise ValueError("empty text")
            audio = asyncio.run(synth(text, voice, rate, pitch, volume))
            status, body = 0, audio
        except Exception as exc:  # noqa: BLE001 —— 任何失败都要让 Node 侧看见原因
            status, body = 1, f"{type(exc).__name__}: {exc}".encode("utf-8", "replace")
        stdout.write(bytes([status]))
        stdout.write(struct.pack(">I", len(body)))
        stdout.write(body)
        stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
`;
function resolvePython(configured) {
	if (configured !== void 0 && configured.trim() !== "") return configured.trim();
	if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON;
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	if (home) {
		const bundled = [join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"), join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "bin", "python3")];
		for (const candidate of bundled) if (existsSync(candidate)) return candidate;
	}
	return process.platform === "win32" ? "python.exe" : "python3";
}
/** 驱动脚本落盘位置（每进程只写一次） */
let scriptPath;
function ensureScript(userRoot) {
	if (scriptPath !== void 0 && existsSync(scriptPath)) return scriptPath;
	const dir = join(userRoot, "cache");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "tts-worker.py");
	writeFileSync(file, TTS_WORKER_SCRIPT, "utf8");
	scriptPath = file;
	return file;
}
function createTtsWorker(python, script) {
	let child;
	let buffer = Buffer.alloc(0);
	let pending = [];
	let starting;
	let dead = false;
	/** 按长度前缀切包，逐条兑现等待者 */
	function onData(chunk) {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 5) {
			const status = buffer[0];
			const length = buffer.readUInt32BE(1);
			if (buffer.length < 5 + length) return;
			const body = buffer.subarray(5, 5 + length);
			buffer = buffer.subarray(5 + length);
			const waiting = pending.shift();
			if (waiting === void 0) continue;
			clearTimeout(waiting.timer);
			if (status === 0) waiting.resolve({
				ok: true,
				audio: new Uint8Array(body),
				mime: "audio/mpeg"
			});
			else {
				const message = body.toString("utf8");
				const isImportError = /ModuleNotFoundError|No module named '?edge_tts/.test(message);
				waiting.resolve({
					ok: false,
					reason: isImportError ? "edge-tts-missing" : "error",
					message: isImportError ? "Python 里没有 edge-tts（请执行 pip install edge-tts）" : message
				});
			}
		}
	}
	/** 确保进程在跑；失败抛错（由调用方转成结构化失败） */
	function ensure() {
		if (child !== void 0 && !dead) return Promise.resolve();
		if (starting !== void 0) return starting;
		starting = new Promise((resolvePromise, reject) => {
			const spawned = spawn(python, [script], {
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
			let settled = false;
			spawned.on("error", (err) => {
				if (settled) return;
				settled = true;
				starting = void 0;
				reject(err.code === "ENOENT" ? Object.assign(new Error(`找不到 Python：${python}`), { code: "python-missing" }) : err);
			});
			spawned.on("spawn", () => {
				if (settled) return;
				settled = true;
				child = spawned;
				buffer = Buffer.alloc(0);
				dead = false;
				starting = void 0;
				resolvePromise();
			});
			spawned.stdout.on("data", (chunk) => onData(chunk));
			spawned.stderr.on("data", () => {});
			spawned.on("close", () => {
				dead = true;
				child = void 0;
				const waiting = pending;
				pending = [];
				for (const p of waiting) {
					clearTimeout(p.timer);
					p.resolve({
						ok: false,
						reason: "worker-dead",
						message: "语音合成进程意外退出"
					});
				}
			});
		});
		return starting;
	}
	async function synthesize$1(text, voice, rate, extras = {}) {
		const trimmed = text.trim();
		if (trimmed === "") return {
			ok: false,
			reason: "empty-text",
			message: "要合成的文本为空"
		};
		try {
			await ensure();
		} catch (e) {
			const err = e;
			if (err.code === "python-missing") return {
				ok: false,
				reason: "python-missing",
				message: err.message
			};
			return {
				ok: false,
				reason: "error",
				message: err.message
			};
		}
		const running = child;
		if (running === void 0) return {
			ok: false,
			reason: "worker-dead",
			message: "语音合成进程不可用"
		};
		const payload = Buffer.from(JSON.stringify({
			text: trimmed,
			voice,
			rate,
			pitch: extras.pitch ?? "",
			volume: extras.volume ?? ""
		}), "utf8");
		const header = Buffer.alloc(4);
		header.writeUInt32BE(payload.length, 0);
		return new Promise((resolvePromise) => {
			const timer = setTimeout(() => {
				pending = pending.filter((p) => p.timer !== timer);
				child?.kill();
				resolvePromise({
					ok: false,
					reason: "timeout",
					message: `语音合成超时（${TTS_TIMEOUT_MS} ms）`
				});
			}, TTS_TIMEOUT_MS);
			pending.push({
				resolve: resolvePromise,
				timer
			});
			try {
				running.stdin.write(header);
				running.stdin.write(payload);
			} catch (e) {
				clearTimeout(timer);
				pending = pending.filter((p) => p.timer !== timer);
				resolvePromise({
					ok: false,
					reason: "worker-dead",
					message: e instanceof Error ? e.message : String(e)
				});
			}
		});
	}
	/** 插件卸载时收掉子进程，别留孤儿 */
	function dispose() {
		child?.kill();
		child = void 0;
		dead = true;
	}
	return {
		synthesize: synthesize$1,
		dispose
	};
}
/** 每个 (python, 用户目录) 组合一个 worker —— 正常情况只有一个 */
const workers = new Map();
/** 取（或建）worker；key 里带 python 路径，换解释器时不会复用旧进程 */
function workerFor(python, userRoot) {
	const key = `${python}::${userRoot}`;
	const existing = workers.get(key);
	if (existing !== void 0) return existing;
	const created = createTtsWorker(python, ensureScript(userRoot));
	workers.set(key, created);
	return created;
}
function disposeVoiceWorkers() {
	for (const worker of workers.values()) worker.dispose();
	workers.clear();
}
/**
* 本地 TTS 网关（GPT-SoVITS）合成。
*
* ── 为什么要走 HTTP 网关而不是直接调 Python ──
* GPT-SoVITS 本体是一个常驻的 Python 服务（api_v2.py 听 9880），换音色要重新加载
* 上百 MB 权重。把它塞进宿主进程既没法热重载、又会让插件启动慢几十秒。
* 所以这里只做一件事：**调一个已经在跑的 HTTP 网关**（默认 127.0.0.1:50123）。
* 网关负责切换权重、挑情感参考音频；插件只知道「给文本和音色，拿 WAV」。
*
* ── 为什么必须先健康检查 ──
* 服务没起来时 fetch 会等到超时（网关内部给合成留了 180 秒）。桌宠按住说话是
* **实时交互**，等三分钟等于卡死。所以先打 /health，2.5 秒不通就直接回退 edge-tts。
*
* ── 为什么返回 WAV 也要检查 ──
* 网关出错时返回的是 JSON 错误体，不是音频。只看 `response.ok` 会把一段 JSON
* 当音频丢给播放器，表现为「点了没声，也没有报错」——最难查的那种。所以校验 RIFF 头。
*/
async function synthesizeGateway(endpoint, text, options) {
	const base = endpoint.trim().replace(/\/+$/, "");
	if (base === "") return {
		ok: false,
		reason: "gateway-unavailable",
		message: "本地 TTS 网关地址为空（voice.json 的 endpoint）"
	};
	try {
		const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
		if (!health.ok) return {
			ok: false,
			reason: "gateway-unavailable",
			message: `本地 TTS 网关未就绪（HTTP ${health.status}）`
		};
	} catch (e) {
		return {
			ok: false,
			reason: "gateway-unavailable",
			message: `本地 TTS 网关不可用：${base}（${e instanceof Error ? e.message : String(e)}）`
		};
	}
	try {
		const response = await fetch(`${base}/tts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text,
				...options.voice === void 0 ? {} : { voice: options.voice },
				...options.style === void 0 ? {} : { style: options.style }
			}),
			signal: AbortSignal.timeout(12e4)
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return {
				ok: false,
				reason: "gateway-error",
				message: `本地 TTS 网关 ${response.status}：${detail.slice(0, 300)}`
			};
		}
		const audio = new Uint8Array(await response.arrayBuffer());
		if (audio.length < 12 || audio[0] !== 82 || audio[1] !== 73 || audio[2] !== 70 || audio[3] !== 70) return {
			ok: false,
			reason: "gateway-error",
			message: "本地 TTS 网关没有返回 WAV（RIFF 头缺失）"
		};
		return {
			ok: true,
			audio,
			mime: "audio/wav"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "gateway-error",
			message: `本地 TTS 网关调用失败：${e instanceof Error ? e.message : String(e)}`
		};
	}
}
async function synthesize(userRoot, text, options = {}) {
	const provider = options.provider ?? "edge";
	if (provider === "gpt-sovits") {
		const local = await synthesizeGateway(options.endpoint ?? DEFAULT_GATEWAY_ENDPOINT, text, {
			voice: options.voice,
			style: options.style
		});
		if (local.ok) return local;
		console.warn(`[dsh-whale-girl] 本地 GPT-SoVITS 失败，回退 edge-tts：${local.message}`);
	}
	const edgeVoice = typeof options.voice === "string" && /^[a-z]{2}-[A-Z]{2}-/i.test(options.voice) ? options.voice : DEFAULT_VOICE;
	const python = resolvePython(options.pythonPath);
	const worker = workerFor(python, userRoot);
	return worker.synthesize(text, edgeVoice, options.rate ?? DEFAULT_RATE, {
		pitch: options.pitch,
		volume: options.volume
	});
}
async function transcribe(ctx, audio, options = {}) {
	if (audio.length === 0) return {
		ok: false,
		reason: "empty-audio",
		message: "录音为空"
	};
	let raw;
	try {
		raw = ctx.get?.("speechToText", false);
	} catch {
		raw = void 0;
	}
	const stt = raw;
	if (stt === void 0 || typeof stt.resolve !== "function" || typeof stt.transcribe !== "function") return {
		ok: false,
		reason: "service-missing",
		message: "DSH 的语音识别服务不可用（没装/没启用 speechToText）"
	};
	try {
		const snapshot = stt.snapshot?.();
		const providerId = snapshot?.selection?.providerId;
		if (!providerId) return {
			ok: false,
			reason: "provider-missing",
			message: "没有可用的语音识别 provider（请在 DSH 设置里启用语音识别）"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const signal = options.signal ?? AbortSignal.timeout(ASR_TIMEOUT_MS);
	try {
		const spec = stt.resolve({
			audio,
			...options.language === void 0 ? {} : { language: options.language }
		});
		const transcript = await stt.transcribe(spec, signal);
		const text = String(transcript?.text ?? "").trim();
		if (text === "") return {
			ok: false,
			reason: "error",
			message: "没听清（识别结果为空）"
		};
		return {
			ok: true,
			text,
			audioSeconds: Number(transcript?.audioSeconds ?? 0)
		};
	} catch (e) {
		return {
			ok: false,
			reason: "error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
function decodeAudioBase64(input) {
	const raw = input.includes(",") ? input.slice(input.indexOf(",") + 1) : input;
	if (raw.trim() === "") return void 0;
	try {
		const buf = Buffer.from(raw, "base64");
		return buf.length === 0 ? void 0 : new Uint8Array(buf);
	} catch {
		return void 0;
	}
}

//#endregion
//#region src/host/sight.ts
/** 压缩后的目标宽度（像素）。1280 足够看清 UI 与游戏画面，又不会让 token 爆掉。 */
const TARGET_WIDTH = 1280;
/** JPEG 质量。72 在「文字可读」与「体积小」之间比较均衡。 */
const JPEG_QUALITY = 72;
/** 单张截图的硬上限：超过说明压缩没生效，宁可失败也不要把巨图发出去。 */
const MAX_JPEG_BYTES = 900 * 1024;
/** 截图临时文件用的临时目录名（只在插件用户目录下建） */
const SHOT_DIR_NAME = "sight";
/**
* 跑一段 PowerShell 脚本，脚本内容**从 stdin 送进去**。
*
* 为什么不用 `promisify(execFile)`：那个封装不接受 `input` 选项
* （只有 `execSync`/`spawnSync` 才有），脚本根本传不进去，表现为
* 「Command failed: powershell.exe … -Command -」但没有任何有用错误。
* 走 ``-Command -`` 让 PowerShell 从标准输入读脚本，顺带绕开命令行长度与引号转义。
*/
function runPowerShell$2(script) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"-"
		], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("截图超时"));
		}, 2e4);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 64 * 1024 * 1024) child.kill();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`截图脚本退出码 ${String(code)}：${stderr.trim().slice(0, 300)}`));
				return;
			}
			resolvePromise({
				stdout,
				stderr
			});
		});
		child.stdin.end(script, "utf8");
	});
}
async function captureScreen(region) {
	const t0 = Date.now();
	const rect = region ?? {
		x: 0,
		y: 0,
		width: 0,
		height: 0
	};
	const useRegion = region !== void 0 && region.width > 0 && region.height > 0;
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$targetW = ${TARGET_WIDTH}
$quality = ${JPEG_QUALITY}
$useRegion = ${useRegion ? "$true" : "$false"}
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($useRegion) { $b = New-Object System.Drawing.Rectangle(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height}) }
if ($b.Width -le 0) { throw 'no-screen' }
$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $full.Size)
$g.Dispose()
$ratio = [Math]::Min(1.0, $targetW / $full.Width)
$nw = [int][Math]::Max(1, [Math]::Round($full.Width * $ratio))
$nh = [int][Math]::Max(1, [Math]::Round($full.Height * $ratio))
$small = New-Object System.Drawing.Bitmap($nw, $nh)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $nw, $nh)
$g2.Dispose()
$full.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, $codec, $ep)
$small.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray())
[Console]::Out.Write(("{0}|{1}|{2}" -f $nw, $nh, $b64))
`;
	const { stdout, stderr } = await runPowerShell$2(script);
	const text = String(stdout).trim();
	const firstBar = text.indexOf("|");
	const secondBar = text.indexOf("|", firstBar + 1);
	if (firstBar < 0 || secondBar < 0) throw new Error(`截图脚本没有返回预期格式（stdout ${text.length} 字符，stderr：${stderr.trim().slice(0, 300) || "空"}）`);
	const width = Number(text.slice(0, firstBar));
	const height = Number(text.slice(firstBar + 1, secondBar));
	const base64 = text.slice(secondBar + 1).replace(/\s+/g, "");
	if (!Number.isFinite(width) || !Number.isFinite(height) || base64 === "") throw new Error("截图结果无法解析");
	const bytes = Math.floor(base64.length * 3 / 4);
	if (bytes > MAX_JPEG_BYTES) throw new Error(`截图过大（${Math.round(bytes / 1024)} KB），已跳过`);
	return {
		dataUrl: `data:image/jpeg;base64,${base64}`,
		bytes,
		width,
		height,
		elapsedMs: Date.now() - t0
	};
}
async function saveSnapshot(sightRoot, jpegBase64, keep) {
	try {
		await mkdir(sightRoot, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = join(sightRoot, `${stamp}.jpg`);
		await writeFile(file, Buffer.from(jpegBase64, "base64"));
		if (keep > 0) {
			const names = (await readdir(sightRoot)).filter((n) => n.endsWith(".jpg")).sort();
			const excess = names.length - keep;
			for (let i = 0; i < excess; i++) try {
				await unlink(join(sightRoot, names[i]));
			} catch {}
		}
		return file;
	} catch {
		return void 0;
	}
}
async function snapshotUsage(sightRoot) {
	try {
		const names = (await readdir(sightRoot)).filter((n) => n.endsWith(".jpg"));
		let bytes = 0;
		for (const name of names) try {
			bytes += (await stat(join(sightRoot, name))).size;
		} catch {}
		return {
			count: names.length,
			bytes
		};
	} catch {
		return {
			count: 0,
			bytes: 0
		};
	}
}
const SIGHT_DIR = SHOT_DIR_NAME;
function frameDiff(previous, current) {
	if (previous === void 0) return 1;
	if (previous.length === 0 || current.length === 0) return 1;
	const lengthDelta = Math.abs(previous.length - current.length) / Math.max(previous.length, current.length);
	let changed = 0;
	const samples = 512;
	const limit = Math.min(previous.length, current.length);
	for (let i = 0; i < samples; i++) {
		const idx = Math.floor(i / samples * limit);
		if (previous[idx] !== current[idx]) changed++;
	}
	const sampleDelta = changed / samples;
	return Math.max(lengthDelta, sampleDelta);
}
async function captureFrames(count, gapMs, capture = captureScreen) {
	const frames = [];
	for (let i = 0; i < Math.max(1, count); i++) {
		frames.push(await capture());
		if (i + 1 < count) await new Promise((r) => setTimeout(r, gapMs));
	}
	return frames;
}

//#endregion
//#region src/host/voice-vision.ts
/** 命中这些词的才会触发 auto 档 */
const LOOK_HINTS = [
	"看",
	"瞧",
	"瞅",
	"这个",
	"那个",
	"画面",
	"屏幕",
	"我在干嘛",
	"我在做什么",
	"你猜",
	"怎么样",
	"好看吗",
	"这个游戏",
	"我在玩",
	"注意到",
	"发现了"
];
function shouldLookAtScreen(text, mode, manual = false) {
	if (manual) return true;
	if (mode === "off") return false;
	if (mode === "always") return true;
	const lower = text.toLowerCase();
	return LOOK_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}
function framePlan(frames, gapMs = 700) {
	const count = Math.max(1, Math.min(5, Math.round(Number.isFinite(frames) ? frames : 1)));
	const gap = Math.max(200, Math.min(2e3, Math.round(Number.isFinite(gapMs) ? gapMs : 700)));
	return {
		count,
		gapMs: gap
	};
}
function frameCaption(count, gapMs) {
	if (count <= 1) return "这是你当前屏幕的样子。";
	const span = (count - 1) * gapMs / 1e3;
	return `接下来是 ${count} 张连续截图（按时间顺序，间隔约 ${gapMs} 毫秒，共 ${span.toFixed(1)} 秒），可以对比出画面在怎么变化。`;
}

//#endregion
//#region src/host/voice-intent.ts
/** 去掉标点与空白，便于中文匹配 */
function normalize$1(text) {
	return text.replace(/[，。！？、；：「」【】（）《》,.!?;:()[\]<>'"]/g, "").replace(/\s+/g, "").toLowerCase();
}
/** 判断一句话是不是「让某功能 开/关」，返回目标状态 */
function onOff(text) {
	if (/关闭|关掉|别|不要|停止|停用/.test(text)) return false;
	if (/打开|开启|启动|打开吧|开一下|启用/.test(text)) return true;
	return void 0;
}
function parseVoiceIntent(raw) {
	const text = normalize$1(raw);
	if (text === "") return void 0;
	if (/^(停|停下|停下来|别动|停手|停止操作|急停)$/.test(text) || /马上停下|立刻停下|先停下/.test(text)) return { kind: "stop-now" };
	if (/结束本局|结束这局|这局结束|玩完了|不玩了|收工|结束游戏/.test(text)) return { kind: "end-session" };
	if (/看一眼|看一下|看看屏幕|你看一眼|瞧瞧|瞅一眼/.test(text)) return { kind: "look-now" };
	if (/识屏|看屏幕|看视屏/.test(text) && /开|关|停|启用|别/.test(text)) {
		const want = onOff(text);
		if (want !== void 0) return {
			kind: "toggle-sight",
			on: want
		};
	}
	if (/代打|自动玩|替我玩|帮我玩/.test(text) && /开|关|停|启用|别/.test(text)) {
		const want = onOff(text);
		if (want !== void 0) return {
			kind: "toggle-autoplay",
			on: want
		};
	}
	if (/现在什么状态|状态怎么样|在干什么|本局多少步|进度多少/.test(text)) return { kind: "status" };
	const openMatch = raw.match(/(?:帮我)?(?:打开|启动|运行)\s*([^\s，。！？,.!?]{1,30})/);
	if (openMatch !== null) {
		const target = openMatch[1].trim();
		if (target !== "" && !/识屏|代打|看屏幕/.test(target)) return {
			kind: "open-app",
			target
		};
	}
	const searchMatch = raw.match(/(?:帮我)?(?:搜一下|搜搜|查一下|查查|搜索)\s*(.{1,60})/);
	if (searchMatch !== null) {
		const query = searchMatch[1].trim();
		if (query !== "") return {
			kind: "search",
			query
		};
	}
	return void 0;
}
function intentReply(intent, detail) {
	switch (intent.kind) {
		case "end-session": return detail ?? "这局收工啦，我都记住了。";
		case "toggle-sight": return intent.on === false ? "好，我不看了。" : "好，我盯着屏幕。";
		case "toggle-autoplay": return intent.on === false ? "好，我停手。" : "好，我来操作。";
		case "stop-now": return "停了。";
		case "open-app": return `好，打开${intent.target}。`;
		case "look-now": return detail ?? "嗯，我看看。";
		case "status": return detail ?? "我在呢。";
		case "search": return detail ?? `我去查查「${intent.query}」。`;
	}
}

//#endregion
//#region src/host/computer.ts
async function runCommand(subprocess, argv, opts = {}) {
	if (subprocess === void 0 || typeof subprocess.spawn !== "function") return {
		ok: false,
		reason: "subprocess-unavailable",
		message: "没有可用的进程服务"
	};
	if (argv.length === 0) return {
		ok: false,
		reason: "empty-argv",
		message: "没有要执行的命令"
	};
	const timeoutMs = Math.max(1e3, Math.min(6e4, opts.timeoutMs ?? 15e3));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const handle = subprocess.spawn({
			argv,
			cwd: opts.cwd ?? process.cwd(),
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 256 * 1024 },
				stderr: { maxBytes: 64 * 1024 }
			},
			graceMs: 2e3
		});
		const outcome = await handle.done;
		const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
		const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
		const exitCode = outcome.exitCode ?? -1;
		if (exitCode !== 0) return {
			ok: false,
			reason: "exit-nonzero",
			message: (stderr.trim() || stdout.trim() || `命令退出码 ${exitCode}`).slice(0, 300)
		};
		return {
			ok: true,
			exitCode,
			stdout
		};
	} catch (e) {
		return {
			ok: false,
			reason: "spawn-failed",
			message: e instanceof Error ? e.message : String(e)
		};
	} finally {
		clearTimeout(timer);
	}
}
async function runPowerShell$1(subprocess, script, opts = {}) {
	const full = "[Console]::OutputEncoding = [Text.Encoding]::UTF8;" + script;
	const encoded = Buffer.from(full, "utf16le").toString("base64");
	return runCommand(subprocess, [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		encoded
	], opts);
}
async function listWindows(subprocess) {
	const script = "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
	const result = await runPowerShell$1(subprocess, script, { timeoutMs: 15e3 });
	if (!result.ok || result.stdout.trim() === "") return [];
	try {
		const parsed = JSON.parse(result.stdout.trim());
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return rows.filter((r) => typeof r.MainWindowTitle === "string" && r.MainWindowTitle !== "").map((r) => ({
			title: String(r.MainWindowTitle),
			processName: String(r.ProcessName ?? ""),
			pid: Number(r.Id ?? 0)
		}));
	} catch {
		return [];
	}
}
function findWindow(windows, query) {
	const q = query.trim().toLowerCase();
	if (q === "") return void 0;
	let best;
	let bestScore = 0;
	for (const w of windows) {
		const title = w.title.toLowerCase();
		const proc = w.processName.toLowerCase();
		let score = 0;
		if (title === q || proc === q) score = 100;
		else if (title.includes(q)) score = 80;
		else if (proc.includes(q)) score = 70;
		else if (q.includes(proc) && proc.length >= 3) score = 60;
		else if (q.includes(title) && title.length >= 3) score = 50;
		if (score > bestScore) {
			bestScore = score;
			best = w;
		}
	}
	return bestScore >= 30 ? best : void 0;
}
const DEFAULT_APP_ALIASES = {
	微信: "WeChat",
	wechat: "WeChat",
	qq: "QQ",
	扣扣: "QQ",
	钉钉: "DingTalk",
	dingtalk: "DingTalk",
	飞书: "Feishu",
	企业微信: "WXWork",
	电报: "Telegram",
	telegram: "Telegram",
	微信输入法: "WeChatInput",
	浏览器: "msedge",
	edge: "msedge",
	谷歌浏览器: "chrome",
	chrome: "chrome",
	火狐: "firefox",
	firefox: "firefox",
	"360浏览器": "360se",
	网易云音乐: "cloudmusic",
	网易云: "cloudmusic",
	qq音乐: "QQMusic",
	酷狗音乐: "KuGou",
	酷我音乐: "KwMusic",
	哔哩哔哩: "bilibili",
	b站: "bilibili",
	哔哩: "bilibili",
	爱奇艺: "iqiyi",
	腾讯视频: "QQLive",
	优酷: "Youku",
	potplayer: "PotPlayerMini64",
	vlc: "vlc",
	word: "WINWORD",
	excel: "EXCEL",
	ppt: "POWERPNT",
	powerpoint: "POWERPNT",
	记事本: "notepad",
	notepad: "notepad",
	写字板: "write",
	画图: "mspaint",
	截图: "SnippingTool",
	onenote: "ONENOTE",
	印象笔记: "Evernote",
	vscode: "code",
	"visual studio code": "code",
	代码编辑器: "code",
	终端: "wt",
	命令提示符: "cmd",
	cmd: "cmd",
	powershell: "powershell",
	任务管理器: "taskmgr",
	资源管理器: "explorer",
	文件管理器: "explorer",
	计算器: "calc",
	控制面板: "control",
	设置: "ms-settings:",
	steam: "steam",
	商店: "ms-windows-store:",
	日历: "outlookcal:",
	微信开发者工具: "wechatdevtools"
};
async function openApp(subprocess, target, aliases) {
	const name = target.trim();
	if (name === "") return {
		ok: false,
		reason: "empty-target",
		message: "没说是哪个应用"
	};
	const table = aliases ?? DEFAULT_APP_ALIASES;
	const resolved = table[name] ?? table[name.toLowerCase()] ?? name;
	const escaped = resolved.replace(/'/g, "''");
	const script = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$name = '" + escaped + "'",
		"try { Start-Process $name -ErrorAction Stop; [Console]::Out.Write('OK'); exit 0 } catch {}",
		"$appPath = 'HKLM:SOFTWAREMicrosoftWindowsCurrentVersionApp Paths' + $name + '.exe'",
		"$hit = (Get-ItemProperty -Path $appPath -ErrorAction SilentlyContinue).'(default)'",
		"if (-not $hit) {",
		"  $roots = @($env:ProgramFiles, [Environment]::GetFolderPath('ProgramFilesX86'), $env:LOCALAPPDATA)",
		"  foreach ($root in $roots) {",
		"    if (-not $root) { continue }",
		"    $found = Get-ChildItem -Path $root -Filter ($name + '.exe') -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1",
		"    if ($found) { $hit = $found.FullName; break }",
		"  }",
		"}",
		"if (-not $hit) {",
		"  $progs = [Environment]::GetFolderPath('Programs')",
		"  $lnk = Get-ChildItem -Path $progs -Filter ($name + '.lnk') -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1",
		"  if ($lnk) { $hit = $lnk.FullName }",
		"}",
		"if (-not $hit) { [Console]::Out.Write('NOTFOUND'); exit 1 }",
		"try { Start-Process $hit -ErrorAction Stop; [Console]::Out.Write('OK'); exit 0 }",
		"catch { [Console]::Out.Write('FAILED'); exit 1 }"
	].join("\n");
	const result = await runPowerShell$1(subprocess, script, { timeoutMs: 3e4 });
	if (result.ok && result.stdout.includes("OK")) return result;
	const said = result.ok ? result.stdout : "";
	if (said.includes("NOTFOUND") || result.ok) return {
		ok: false,
		reason: "not-found",
		message: `系统里找不到「${resolved}」。去设置→更多→应用名单里补上它的可执行名或完整路径，就认得它了。`
	};
	return {
		ok: false,
		reason: "launch-failed",
		message: `启动 ${resolved} 失败`
	};
}
async function focusWindow(subprocess, pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId(); [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool f);'",
		"Add-Type -MemberDefinition $sig -Name W -Namespace DshFg | Out-Null",
		`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
		"if ($p -eq $null) { [Console]::Out.Write(\"NO_PROCESS\"); exit 0 }",
		"$h = $p.MainWindowHandle",
		"if ($h -eq 0) { [Console]::Out.Write(\"NO_WINDOW\"); exit 0 }",
		"[void][DshFg.W]::ShowWindow($h, 9)",
		"$fg = [DshFg.W]::GetForegroundWindow()",
		"$fgPid = 0",
		"$fgThread = [DshFg.W]::GetWindowThreadProcessId($fg, [ref]$fgPid)",
		"$myThread = [DshFg.W]::GetCurrentThreadId()",
		"[void][DshFg.W]::AttachThreadInput($myThread, $fgThread, $true)",
		"$ok = [DshFg.W]::SetForegroundWindow($h)",
		"[void][DshFg.W]::BringWindowToTop($h)",
		"[void][DshFg.W]::AttachThreadInput($myThread, $fgThread, $false)",
		"if ($ok) { [Console]::Out.Write(\"OK\") } else { [Console]::Out.Write(\"FAILED\") }"
	].join("\n");
	const result = await runPowerShell$1(subprocess, script, { timeoutMs: 15e3 });
	return result.ok && result.stdout.trim().endsWith("OK");
}

//#endregion
//#region src/host/vision-llm.ts
/**
* 选这个模型最省的 reasoning effort。
*
* 为什么在这里内联一份（而不是 import ./llm-reasoning）：tools 下的测试直接用
* node 的 TS 类型擦除跑 src 目录里的 .ts，相对路径 import 必须带扩展名才能解析；
* 而 tsc 的当前配置又不允许 .ts 扩展名。vision-llm.ts 之前只 import 了外部包，
* 是这批测试能直接跑的原因。为一行探测把测试链搞坏不值得，所以内联。
* （chat/whisper 走的是 pnpm test 的 register 解析器，不受这条限制，仍用 llm-reasoning。）
*/
async function cheapestEffort(ctx, provider, model) {
	const llm = ctx.llm;
	if (llm === void 0 || typeof llm.resolveModelInfo !== "function") return void 0;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		const ids = (info?.reasoning?.efforts ?? []).map((e) => e.id);
		if (ids.length === 0) return void 0;
		for (const preferred of [
			"low",
			"off",
			"minimal"
		]) if (ids.includes(preferred)) return preferred;
		return ids[0];
	} catch {
		return void 0;
	}
}
/** 单次视觉请求超时：推理模型看图 + 思考，给足 60 秒 */
const TIMEOUT_MS$1 = 6e4;
/**
* 输出预算 —— **必须给足**。
*
* 推理模型先吐 reasoning 再吐 content，两者共用这一份预算。
* 给 200 时实测 200 全被思考吃掉、`content` 是空串（看着像「模型什么都没返回」）。
*/
const MAX_TOKENS = 1024;
const PROMPT_COMMON_TAIL = `
4. 绝不编造你看不清的内容。看不清就按第 3 条处理。
5. 不要说"我看到"、"根据画面"这类旁白，直接说话。
6. 不要提你是 AI。
7. **不要用任何 Markdown 符号**（不要反引号、星号、井号、代码块）——这段话会原样显示在气泡里，符号会变成乱码。要提代码或文件名就直接写，不加修饰。`;
const PROMPTS = {
	companion: `你正坐在主人旁边一起用电脑，看到的是 TA 现在的屏幕。

像熟人一样随口搭一句（1~2 句，中文，口语，可以有情绪）。这是**搭话，不是汇报**：
1. **不要复述屏幕内容**——不要说「你在看/你在写/画面里/这里显示…」，直接说你的反应、吐槽、好奇或关心；
2. 可以问一句、开玩笑、催一催、夸一下；每次换角度、换开头，别用同一个句式；
3. 看到值得注意的事（打得精彩、报错、卡关、快没血了）就直说，别念说明书；
4. 如果画面没什么可说的（桌面、静态文档、聊天软件、什么都看不懂），**只回 [SKIP] 四个字符**，不要解释。${PROMPT_COMMON_TAIL}`,
	play: `你正坐在主人旁边**看他玩游戏**。你会看到游戏画面。

像真的在旁边看人打游戏那样说一句（不超过 40 字，口语，中文）。

规则：
1. **先说局势再说建议**：战况怎么样、谁占优、资源/血量/时间紧不紧张。
2. 看到**具体该做的决定**就直接说（该开团了、这个科技树先点那个、留钱别乱花、这里能绕后）。
   不确定就只描述局势，不要瞎指挥。
3. 打得精彩就叫好，要崩了就提醒——像朋友那样，不要念说明书。
4. 如果画面不是游戏（桌面、聊天、文档），或者你看不出局势，**只回 [SKIP]**，不要硬聊。
${PROMPT_COMMON_TAIL}`,
	watch: `你在观察主人的屏幕，但**这次不要说话**——你的输出会被程序拿去判断下一步动作，不会显示给主人。

请只做客观描述（不超过 80 字，中文，不要 Markdown）：
1. 这是什么界面/游戏？
2. 当前关键状态（血量、资源、棋盘局面、菜单选项、可点击的按钮）。
3. 如果是游戏回合，现在是该谁行动。

看不清就说明看不清，**不要猜**。不要回 [SKIP]，这里需要描述而不是沉默。`,
	action: `你在替主人操作游戏。只输出下一步的**一行动作指令**，不要描述画面、不要解释、不要 Markdown。`
};
async function lookAtScreen(ctx, jpeg, model, mode, hint, afterCall, systemOverride) {
	const started = Date.now();
	if (model.provider === "" || model.model === "") return {
		ok: false,
		reason: "no-model",
		message: "还没选识图模型"
	};
	if (typeof ctx.attachments?.saveImages !== "function") return {
		ok: false,
		reason: "attachments-missing",
		message: "附件服务不可用（无法把图片交给模型）"
	};
	let refs = [];
	try {
		const frames = Array.isArray(jpeg) ? jpeg : [jpeg];
		if (frames.length === 0) return {
			ok: false,
			reason: "attachments-missing",
			message: "没有可用的画面"
		};
		refs = await ctx.attachments.saveImages(frames.map((data, i) => ({
			data,
			mediaType: "image/jpeg",
			name: "screen-" + (i + 1) + ".jpg"
		})));
		if (refs.length === 0) return {
			ok: false,
			reason: "attachments-missing",
			message: "附件存不进去"
		};
		const userText = mode === "watch" || mode === "action" ? hint === void 0 || hint.trim() === "" ? mode === "action" ? "看这张画面，输出下一步动作。" : "描述这个画面。" : hint : hint === void 0 || hint.trim() === "" ? "看看我现在在干什么。" : `看看我现在在干什么。${hint}`;
		const systemText = systemOverride ?? PROMPTS[mode];
		const effort = mode === "action" ? await cheapestEffort(ctx, model.provider, model.model) : void 0;
		const budget = mode === "action" ? 8192 : MAX_TOKENS;
		const blocks = [...refs.map((r) => ({
			type: "image",
			attachment: r
		})), {
			type: "text",
			text: userText
		}];
		const userMessage = createUserMessage({
			content: blocks,
			source: { kind: "user" }
		});
		/** 跑一次流式请求，返回拼好的正文（空串 = 模型只思考没产出正文） */
		const attempt = async (maxTokens) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TIMEOUT_MS$1);
			let text = "";
			try {
				const stream = ctx.llm.stream({
					provider: model.provider,
					model: model.model,
					system: systemText,
					messages: [userMessage],
					maxTokens,
					...effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(effort) },
					signal: controller.signal,
					sessionId: "dsh-whale-girl:sight"
				});
				for await (const chunk of stream) if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
				else if (chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
					if (text === "") text = chunk.block.text;
				} else if (chunk.type === "finish") break;
			} finally {
				clearTimeout(timer);
			}
			return text.trim();
		};
		let trimmed = await attempt(budget);
		if (trimmed === "" && mode === "action") {
			console.warn("[dsh-whale-girl] 识图模型只思考没吐正文，翻倍预算重试一次：" + model.provider + "/" + model.model);
			trimmed = await attempt(budget * 2);
		}
		if (trimmed === "") return {
			ok: false,
			reason: "empty-reply",
			message: "模型没有返回内容"
		};
		return {
			ok: true,
			text: trimmed,
			model: `${model.provider}/${model.model}`,
			elapsedMs: Date.now() - started
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/abort/i.test(msg)) return {
			ok: false,
			reason: "timeout",
			message: `请求超时（${TIMEOUT_MS$1} ms）`
		};
		if (/401|403|unauthor/i.test(msg)) return {
			ok: false,
			reason: "unauthorized",
			message: msg
		};
		if (/429|rate.?limit|频率/i.test(msg)) return {
			ok: false,
			reason: "rate-limited",
			message: msg
		};
		return {
			ok: false,
			reason: "bad-response",
			message: msg
		};
	} finally {
		afterCall?.(refs);
	}
}
async function probeModelLatency(ctx, model, effort) {
	const started = Date.now();
	try {
		let text = "";
		const stream = ctx.llm.stream({
			provider: model.provider,
			model: model.model,
			system: "你是回声器。只回两个字：好的。",
			messages: [createUserMessage({
				content: [{
					type: "text",
					text: "回复：好的"
				}],
				source: { kind: "user" }
			})],
			maxTokens: 32,
			...effort === void 0 || effort === "" ? {} : { reasoningEffort: ReasoningEffortId(effort) },
			signal: AbortSignal.timeout(6e4),
			sessionId: "dsh-whale-girl:diag"
		});
		for await (const chunk of stream) if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
		else if (chunk.type === "finish") break;
		return {
			ok: true,
			elapsedMs: Date.now() - started,
			text
		};
	} catch (e) {
		return {
			ok: false,
			elapsedMs: Date.now() - started,
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
function parseSightReply(text) {
	const cleaned = text.replace(/```[\s\S]*?```/g, " ").replace(/[`*_#>|~]/g, "").replace(/\s+/g, " ").trim();
	if (/^[[【]?\s*skip\s*[\]】]?$/i.test(cleaned)) return {
		speak: false,
		text: ""
	};
	if (/[[【]\s*skip\s*[\]】]/i.test(cleaned)) return {
		speak: false,
		text: ""
	};
	return {
		speak: cleaned !== "",
		text: cleaned
	};
}

//#endregion
//#region src/host/autoplay.ts
/**

* 中文游戏名 ↔ 窗口英文标题。

*

* 为什么需要：主人填白名单时用的是**游戏名**（「苏丹的游戏」），而 Windows 窗口标题

* 往往是英文（`Sultan's Game`）。只做 `title.includes(填的)` 会永远不匹配，

* 表现就是「点了开始什么都不发生」——循环一直在等「白名单窗口」。

* 这张表只处理**确实存在的中英对应**，不用模糊猜测（猜错会让她对别的窗口动手）。

*/
const GAME_TITLE_ALIASES = {
	苏丹的游戏: ["sultan's game", "sultans game"],
	星露谷物语: ["stardew valley"],
	群星: ["stellaris"],
	戴森球计划: ["dyson sphere program"],
	环世界: ["rimworld"],
	泰拉瑞亚: ["terraria"],
	我的世界: ["minecraft"],
	缺氧: ["oxygen not included"],
	文明6: ["civilization vi", "civilization 6"],
	饥荒: ["don't starve", "dont starve"],
	无人深空: ["no man’s sky", "no man's sky"],
	边缘世界: ["rimworld"]
};
/** 归一化标题：小写 + 去空格/标点（`Sultan's Game` 与 `sultans game` 等价） */
function normalizeTitle(text) {
	return text.toLowerCase().replace(/[\s'’·:：\-_.,!?()（）[\]【】]/g, "");
}
function windowMatchesAllowed(title, allowedTitles) {
	if (allowedTitles.length === 0) return true;
	const normalized = normalizeTitle(title);
	for (const raw of allowedTitles) {
		const key = typeof raw === "string" ? raw.trim() : "";
		if (key === "") continue;
		if (title.includes(key)) return true;
		const normalizedKey = normalizeTitle(key);
		if (normalizedKey !== "" && normalized.includes(normalizedKey)) return true;
		for (const alias of GAME_TITLE_ALIASES[key] ?? []) {
			const normalizedAlias = normalizeTitle(alias);
			if (normalizedAlias !== "" && normalized.includes(normalizedAlias)) return true;
		}
	}
	return false;
}
const DEFAULT_AUTOPLAY_CONFIG = {
	enabled: false,
	dryRun: true,
	estopKey: "f12",
	windowTitles: []
};
function normalizeAutoplayConfig(raw) {
	const titles = Array.isArray(raw?.windowTitles) ? raw.windowTitles.filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim()) : [];
	const vision = raw?.visionModel;
	const visionModel = vision !== void 0 && typeof vision.provider === "string" && vision.provider.trim() !== "" && typeof vision.model === "string" && vision.model.trim() !== "" ? {
		provider: vision.provider.trim(),
		model: vision.model.trim()
	} : void 0;
	return {
		enabled: raw?.enabled === true,
		dryRun: raw?.dryRun !== false,
		estopKey: typeof raw?.estopKey === "string" && raw.estopKey.trim() !== "" ? raw.estopKey.trim() : "f12",
		windowTitles: titles.slice(0, 20),
		...visionModel === void 0 ? {} : { visionModel }
	};
}
const AUTOPLAY_PROMPT = `你在替主人操作电脑上的游戏。你会看到当前画面。

请判断**下一步做什么**，并且只输出**一行**，格式必须是下面之一：

click X Y            —— 用鼠标左键点屏幕坐标 (X, Y)
rclick X Y           —— 右键点击（也用来取消弹出来的菜单）
drag X1 Y1 X2 Y2     —— 在 (X1,Y1) 按下左键，拖到 (X2,Y2) 再松开（战棋移动单位必须用这个）
key NAME             —— 按一下某个键（NAME 用英文：w a s d space enter esc tab up down left right 0-9）
keydown NAME         —— 按住
keyup NAME           —— 松开
move X Y             —— 只移动鼠标
noop 原因            —— 这一步什么都不做

规则：
1. 一次只输出**一个**动作，或者 noop。不要一次写多个。
2. 坐标用画面像素，左上角是 (0,0)。画面宽高会告诉你。
3. **看不清、不确定、不是游戏界面 → 一律 noop**。乱按比不动危险得多。
4. 不要解释，不要输出第二行，不要用 Markdown。
5. 如果这一屏需要连续操作（比如走一段路），也只输出**当前这一步**。
6. 画面里那个蓝发女仆（Q 版鲸鱼娘）和她头顶的气泡是**助手自己**：不要点她、不要点她的气泡，
   目标是游戏里的按钮/角色/地块。
7. **只要画面确实是游戏**（有角色/棋盘/按钮/关卡），尽量给一个能推进的动作；只有真的看不清、
   不是游戏界面、或正在播不可跳过的动画时才 noop。回合制游戏：没有选中单位就先点一个单位，
   选中了就点目标格，或者按确认/结束回合键。
8. 回合制游戏的常见情况：
   - 弹出对话框/文字提示 → 点一下对话框中央，或按 Z / Enter / 空格 继续；
   - 正在播动画 → 这一轮输出 noop（程序 2.5 秒后会再看一眼）；
   - 地图/棋盘界面 → 先点自己的单位（通常高亮、颜色与敌方不同），选中后再点目标格；
   - 有「结束回合」按钮 → 点它。
9. **先判断现在是不是你的回合**：
   - 画面出现你方单位的高亮/选中框、行动菜单、移动范围格、或「结束回合」按钮 → **是你的回合**：
     选单位 → 点移动目标格 → 交互/攻击；不要因为「不确定」就 noop；
   - 只有出现「敌方回合 / Enemy Turn」字样，或敌方单位正在移动的动画 → 才是对方回合，这时才 noop。
   战棋里通常蓝色/绿色单位是你方，红色是敌方；看颜色和血条上面有没有你的阵营标记。
10. **战棋（Wargroove 这类）的操作方式**：
   - 移动/攻击都是**拖拽**：drag 单位X 单位Y 目标X 目标Y。只 click 不会移动（主人实测）；
   - **画面有菜单时，本轮唯一目标是关掉它**：点菜单里的「取消 / 返回 / 关闭」那一项（通常是菜单最下面一项），
     然后再做别的；**不要用 rclick**——这个游戏的右键也可能打开菜单，越点越乱；
   - 把单位拖到建筑旁的格子 = 占领，拖到敌人旁 = 攻击（然后可能需要再确认一次）。
11. **怎么读 Wargroove 的回合/单位状态**（这些是真实有效的画面规律）：
   - 左上角指挥官头像的**边框颜色** = 当前回合方的颜色；
   - 地图上颜色**鲜艳/高亮**的一侧是当前行动方；**灰暗/降饱和度**的一侧不是当前回合；
   - 单位头顶有**白色小箭头（向上）** = 这个单位本回合**还没行动**；没有箭头的已经行动过；
   - 建筑上的 **Zzz** = 待机；
   - 右下角那个蓝发女仆是**助手 UI**，和战局无关，不要拿她判断任何事。
   先按这几条判断“现在是不是你的回合、还有谁没动”，再决定动作；判断出来了就不要 noop。
12. 如果画面里是「结束回合 / 概览 / 任务 / 取消」这样的竖排菜单：**点最下面的「取消」**把它关掉。
13. **玩家颜色不是固定的**：不要默认「蓝色=我方」。先看左上角指挥官头像/横幅与地图哪边单位同色，
    同色的那一方通常就是玩家；如果游戏档案里写了玩家颜色，以档案为准（例如本机 Wargroove 玩家是红色方「玛丝雅」）。`;
/** 画面上限：一次最多执行的动作数（防御模型输出跑偏） */
const MAX_ACTIONS = 3;
function parseActionPlan(raw, screen) {
	const text = raw.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, "$1").replace(/[`*_#>|]/g, "").trim();
	if (text === "") return {
		kind: "invalid",
		raw,
		reason: "模型没有输出"
	};
	const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
	const lower = line.toLowerCase();
	if (lower.startsWith("noop")) return {
		kind: "noop",
		reason: line.slice(4).trim() || "模型选择不动"
	};
	const clamp = (v, max) => Math.max(0, Math.min(Math.max(0, max - 1), Math.round(v)));
	const twoNums = /^(\d{1,5})\s+(\d{1,5})$/;
	const fourNums = /^(\d{1,5})\s+(\d{1,5})\s+(\d{1,5})\s+(\d{1,5})$/;
	const actions = [];
	let thought = line;
	if (lower.startsWith("drag ")) {
		const rest = line.slice(5).trim();
		const m = rest.match(fourNums);
		if (m === null) return {
			kind: "invalid",
			raw,
			reason: `拖拽坐标格式不对：${rest}`
		};
		actions.push({
			kind: "drag",
			fromX: clamp(Number(m[1]), screen.width),
			fromY: clamp(Number(m[2]), screen.height),
			toX: clamp(Number(m[3]), screen.width),
			toY: clamp(Number(m[4]), screen.height)
		});
	} else if (lower.startsWith("click ") || lower.startsWith("rclick ") || lower.startsWith("move ")) {
		const isRight = lower.startsWith("rclick ");
		const isMove = lower.startsWith("move ");
		const rest = line.slice(line.indexOf(" ") + 1).trim();
		const m = rest.match(twoNums);
		if (m === null) return {
			kind: "invalid",
			raw,
			reason: `坐标格式不对：${rest}`
		};
		const x = clamp(Number(m[1]), screen.width);
		const y = clamp(Number(m[2]), screen.height);
		if (isMove) actions.push({
			kind: "move",
			x,
			y
		});
		else actions.push({
			kind: "click",
			x,
			y,
			...isRight ? { button: "right" } : {}
		});
	} else if (lower.startsWith("key ") || lower.startsWith("keydown ") || lower.startsWith("keyup ")) {
		const mode = lower.startsWith("keydown ") ? "keyDown" : lower.startsWith("keyup ") ? "keyUp" : "key";
		const name = line.slice(line.indexOf(" ") + 1).trim().toLowerCase();
		if (name === "") return {
			kind: "invalid",
			raw,
			reason: "没有给出键名"
		};
		actions.push({
			kind: mode,
			key: name
		});
	} else return {
		kind: "invalid",
		raw,
		reason: `不认识的动作：${line.slice(0, 40)}`
	};
	if (actions.length === 0) return {
		kind: "invalid",
		raw,
		reason: "没解析出动作"
	};
	if (actions.length > MAX_ACTIONS) return {
		kind: "invalid",
		raw,
		reason: `动作太多（${actions.length} > ${MAX_ACTIONS}）`
	};
	thought = line;
	return {
		kind: "act",
		actions,
		thought
	};
}
async function runAutoplayRound(deps, config, estop) {
	/** 游戏档案 + 最近战况：模型靠它知道「这游戏怎么玩、刚才试过什么」 */
	const context = config.gameContext ?? "";
	if (!estop.canAct()) {
		const snap = estop.snapshot();
		return {
			kind: "stopped",
			reason: snap.lastReason ?? "已停止"
		};
	}
	if (config.allowedTitles.length > 0) {
		let title = "";
		try {
			title = await deps.foregroundTitle();
		} catch (e) {
			return {
				kind: "failed",
				reason: "window-check",
				message: e instanceof Error ? e.message : String(e)
			};
		}
		if (!windowMatchesAllowed(title, config.allowedTitles)) return {
			kind: "skipped",
			reason: "window-not-allowed",
			detail: title || "(无标题)"
		};
	}
	let shot;
	try {
		shot = await deps.capture();
	} catch (e) {
		return {
			kind: "failed",
			reason: "capture",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const cached = deps.trySkill?.(shot.jpeg);
	if (cached !== void 0) {
		if (!estop.canAct()) {
			const snap = estop.snapshot();
			return {
				kind: "stopped",
				reason: snap.lastReason ?? "已停止"
			};
		}
		if (config.dryRun) {
			deps.log(`[空跑][技能] ${cached.name}`);
			return {
				kind: "planned",
				thought: `[技能] ${cached.name}`,
				actions: cached.actions,
				executed: false
			};
		}
		estop.markInjecting(true);
		let ok = true;
		try {
			for (const action of cached.actions) {
				if (!estop.canAct()) {
					const snap = estop.snapshot();
					deps.log(`[技能] 执行中途急停：${snap.lastReason ?? "已停止"}`);
					return {
						kind: "stopped",
						reason: snap.lastReason ?? "已停止"
					};
				}
				const result = await deps.perform(action);
				if (!result.ok) {
					ok = false;
					deps.log(`[技能] 动作被拒：${result.message}`);
					break;
				}
			}
		} finally {
			estop.markInjecting(false);
		}
		deps.learnSkill?.(cached.name, cached.actions, ok);
		deps.log(`[技能] 重放 ${cached.name}${ok ? "" : "（失败）"}`);
		return {
			kind: "planned",
			thought: `[技能] ${cached.name}`,
			actions: cached.actions,
			executed: ok
		};
	}
	const described = await deps.describe(shot.jpeg, context, {
		width: shot.width,
		height: shot.height
	});
	if (!described.ok) return {
		kind: "failed",
		reason: "describe",
		message: described.message
	};
	const plan = parseActionPlan(described.text, {
		width: shot.width,
		height: shot.height
	});
	if (plan.kind === "noop") return {
		kind: "skipped",
		reason: "model-noop",
		detail: plan.reason
	};
	if (plan.kind === "invalid") return {
		kind: "skipped",
		reason: "unparseable",
		detail: plan.reason
	};
	if (!estop.canAct()) {
		const snap = estop.snapshot();
		return {
			kind: "stopped",
			reason: snap.lastReason ?? "已停止"
		};
	}
	if (config.dryRun) {
		deps.log(`[空跑] 打算：${plan.thought}`);
		return {
			kind: "planned",
			thought: plan.thought,
			actions: plan.actions,
			executed: false
		};
	}
	estop.markInjecting(true);
	try {
		for (const action of plan.actions) {
			if (!estop.canAct()) {
				const snap = estop.snapshot();
				deps.log(`[代打] 执行中途急停：${snap.lastReason ?? "已停止"}`);
				return {
					kind: "stopped",
					reason: snap.lastReason ?? "已停止"
				};
			}
			const result = await deps.perform(action);
			if (!result.ok) {
				deps.log(`[代打] 动作被拒：${result.message}`);
				return {
					kind: "failed",
					reason: "inject",
					message: result.message
				};
			}
		}
	} finally {
		estop.markInjecting(false);
	}
	deps.log(`[代打] 执行：${plan.thought}`);
	deps.learnSkill?.(described.text, plan.actions, true);
	return {
		kind: "planned",
		thought: plan.thought,
		actions: plan.actions,
		executed: true
	};
}

//#endregion
//#region src/host/estop.ts
/** 允许用作急停的键（收窄，避免主人填一个游戏里天天按的键） */
const ALLOWED_ESTOP_KEYS = {
	f8: 119,
	f9: 120,
	f10: 121,
	f11: 122,
	f12: 123,
	esc: 27,
	pause: 19,
	scrolllock: 145
};
function resolveEstopKey(name) {
	return ALLOWED_ESTOP_KEYS[name.trim().toLowerCase()];
}
function createEstop(hotkey, onStop) {
	const vk = resolveEstopKey(hotkey);
	let state = "ready";
	let lastReason;
	let lastStoppedAt;
	let watching = false;
	/**
	* 正在注入中（>0 表示当前有一次注入在跑）。
	* 注入期产生的键鼠会被 GetLastInputInfo 当成「用户输入」，必须屏蔽掉。
	*/
	let injectingAt = 0;
	/** 上一次读到的空闲毫秒数（-1 = 还没读过） */
	let lastIdle = -1;
	/** 最近一次注入结束的时间戳（0 = 还没注入过）。用来判断某次归零该归给谁 */
	let lastInjectEndedAt = 0;
	/** 宽限期截止时间（毫秒时间戳）：这段时间内不因真实输入而停 */
	let graceUntil = 0;
	let stopWatcher;
	const snapshot = () => ({
		state,
		...lastReason === void 0 ? {} : { lastReason },
		...lastStoppedAt === void 0 ? {} : { lastStoppedAt },
		hotkey
	});
	const stop = (reason) => {
		if (state === "stopped" && lastReason === reason) return;
		state = "stopped";
		lastReason = reason;
		lastStoppedAt = Date.now();
		onStop?.(reason);
	};
	const resume = () => {
		state = "ready";
	};
	/**
	* 全局轮询急停键。
	*
	* 为什么不用注册热键（RegisterHotKey）：那个会被前台游戏抢走，
	* 而且全屏独占时你收不到。**轮询 `GetAsyncKeyState`** 不依赖焦点，全屏也能读到。
	*
	* 用 PowerShell 常驻进程而不是每 100ms 起一个新进程：
	* 起进程要 ~300ms，频繁起会拖慢机器，而且检测会漏。
	*/
	const startWatching = (options) => {
		if (watching) return stopWatcher ?? (() => {});
		if (vk === void 0) {
			stop("error");
			return () => {};
		}
		watching = true;
		const voiceSpec = options?.voiceSpec;
		const bool = (value) => value ? "true" : "false";
		const CS_MONITOR = [
			"using System;",
			"using System.Runtime.InteropServices;",
			"public static class DshEstopMonitor {",
			"  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
			"  [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);",
			"  [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);",
			"  [DllImport(\"kernel32.dll\")] public static extern uint GetTickCount();",
			"  static bool D(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }",
			"  public static uint IdleMs() {",
			"    LASTINPUTINFO li = new LASTINPUTINFO();",
			"    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));",
			"    if (!GetLastInputInfo(ref li)) return uint.MaxValue;",
			"    return GetTickCount() - li.dwTime;",
			"  }",
			"  public static bool HotkeyDown() { return D(" + String(vk) + "); }",
			...voiceSpec === void 0 ? [] : [
				"  public static bool VoiceDown() {",
				"    if (!D(" + String(voiceSpec.vk) + ")) return false;",
				"    if (D(17) != " + bool(voiceSpec.ctrl) + ") return false;",
				"    if (D(18) != " + bool(voiceSpec.alt) + ") return false;",
				"    if (D(16) != " + bool(voiceSpec.shift) + ") return false;",
				"    bool win = D(91) || D(92);",
				"    if (win != " + bool(voiceSpec.win) + ") return false;",
				"    return true;",
				"  }"
			],
			"}"
		].join(" ");
		const voiceExpr = voiceSpec === void 0 ? "$false" : "[DshEstopMonitor]::VoiceDown()";
		const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${CS_MONITOR.replace(/'/g, "''")}' | Out-Null
$voiceHold = 0
while ($true) {
  $voice = ${voiceExpr}
  if ($voice) { $voiceHold = 30 } elseif ($voiceHold -gt 0) { $voiceHold-- }
  if ([DshEstopMonitor]::HotkeyDown()) { [Console]::Out.WriteLine('ESTOP'); [Console]::Out.Flush() }
  $suppress = 0
  if ($voice -or $voiceHold -gt 0) { $suppress = 1 }
  [Console]::Out.WriteLine('IDLE ' + [DshEstopMonitor]::IdleMs() + ' ' + $suppress)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 100
}
`;
		const scriptPath$1 = join(tmpdir(), `dsh-whale-estop-${process.pid}-${Date.now()}.ps1`);
		writeFileSync(scriptPath$1, script, "utf8");
		/**
		* spawn 可能**同步抛出**（实测：受限环境里直接 `EPERM`）。
		*
		* 这里原本没有 try/catch，异常会被 `rearmAutoplay` → `ctx.effect` 一路上抛，
		* 导致**整个插件激活失败**（DSH 起不来，且启动失败的回滚会清掉主人的模型配置，
		* 见 docs/ROADMAP.md 坑 7）。
		*
		* 急停监听起不来时正确的行为是**明确降级**：标记为不可行动，
		* 让上层知道「现在没有急停保护」——而不是让宿主崩掉。
		* 这比「假装在听」安全得多（后者是文件头注释里专门警告过的那种情形）。
		*/
		let child;
		try {
			child = spawn("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath$1
			], { windowsHide: true });
		} catch (error) {
			watching = false;
			stop("error");
			console.warn("[dsh-whale-girl] 急停监听启动失败（进程起不来）：" + (error instanceof Error ? error.message : String(error)) + "——急停不可用，代打不应开启");
			try {
				unlinkSync(scriptPath$1);
			} catch {}
			return () => {};
		}
		let buffer = "";
		/**
		* 上一次看到的「用户空闲时长」。
		*
		* GetLastInputInfo 把**我们自己注入的**键鼠也算成输入，所以不能直接拿它判断
		* 「主人在动」——那会在每次注入后自我触发急停，等于代打一次都跑不了。
		*
		* 判据：注入期间（`injectingAt > 0`）完全不判；注入结束后，空闲计时会因为
		* 我们自己的动作归零一次，于是观察**下一次读取时 idle 是不是又变小了**——
		* 只有「刚归零完又归零」才说明有人真的在动，那时候才停。
		*/
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (process.env.DSH_ESTOP_DEBUG === "1") console.log("[estop] " + JSON.stringify(trimmed));
				if (trimmed.includes("ESTOP")) {
					stop("hotkey");
					continue;
				}
				if (!trimmed.startsWith("IDLE ")) continue;
				const parts = trimmed.split(/\s+/);
				const idle = Number(parts[1]);
				if (!Number.isFinite(idle)) continue;
				const voiceSuppressed = parts[2] === "1";
				if (injectingAt > 0 || voiceSuppressed) {
					lastIdle = idle;
					continue;
				}
				if (lastIdle >= 0) {
					const decreased = idle < lastIdle - 50;
					if (decreased) {
						/**
						* 这一次「归零」该归给谁？
						*
						* 我们自己的注入同样会让空闲计时归零，所以不能一见下降就停。
						* 判据用**时间归属**：注入结束后的 1.5 秒内出现的归零算我们的，
						* 其余都算主人的输入。
						*
						* 早先的写法是「第一次下降吞掉、第二次才停」，那在家里没注入时
						* 会把主人的**第一次**真实输入吞掉（实测测出来就是不停），是错的。
						*/
						const sinceInject = Date.now() - lastInjectEndedAt;
						if (lastInjectEndedAt === 0 || sinceInject > 1500) {
							if (Date.now() >= graceUntil) stop("user-input");
						}
					}
				}
				lastIdle = idle;
			}
		});
		child.stderr.on("data", () => {});
		child.on("error", () => {
			stop("error");
		});
		stopWatcher = () => {
			watching = false;
			try {
				child.kill();
			} catch {}
			try {
				unlinkSync(scriptPath$1);
			} catch {}
		};
		return stopWatcher;
	};
	return {
		snapshot,
		stop,
		resume,
		canAct: () => state === "ready",
		markInjecting: (active) => {
			injectingAt = active ? 1 : 0;
			if (!active) lastInjectEndedAt = Date.now();
			lastIdle = -1;
		},
		grantGrace: (ms) => {
			graceUntil = Date.now() + Math.max(0, ms);
			lastIdle = -1;
		},
		startWatching
	};
}

//#endregion
//#region src/host/play-loop.ts
const DEFAULT_INTERVAL_MS = 1200;
const DEFAULT_FAILURE_DELAY_MS = 3e3;
const DEFAULT_FAILURE_LIMIT = 3;
const DEFAULT_MAX_ROUNDS = 200;
function createPlayLoop(deps) {
	const intervalMs = Math.max(100, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
	const failureDelayMs = Math.max(100, deps.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS);
	const failureLimit = Math.max(1, deps.failureLimit ?? DEFAULT_FAILURE_LIMIT);
	const maxRounds = Math.max(1, deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
	const now = deps.now ?? (() => Date.now());
	const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
	let timer = void 0;
	let running = false;
	/** 每次 start 递增：async 轮次返回时用它判断「这轮是不是已经过期的」 */
	let generation = 0;
	let state = "idle";
	let rounds = 0;
	let startedAtMs;
	let lastMessage = "";
	let lastReason;
	let consecutiveFailures = 0;
	/** 连续「模型观望（noop）」的次数（软计数：不算错误） */
	let idleRounds = 0;
	let lastRoundMs;
	let updatedAtMs = now();
	const snapshot = () => ({
		running,
		state,
		rounds,
		...startedAtMs === void 0 ? {} : { startedAtMs },
		lastMessage,
		...lastReason === void 0 ? {} : { lastReason },
		consecutiveFailures,
		...lastRoundMs === void 0 ? {} : { lastRoundMs },
		updatedAtMs
	});
	const emit = () => {
		updatedAtMs = now();
		deps.onState?.(snapshot());
	};
	const clearTimer = () => {
		if (timer !== void 0) {
			clearTimeoutFn(timer);
			timer = void 0;
		}
	};
	const schedule = (delayMs) => {
		clearTimer();
		const gen = generation;
		timer = setTimeoutFn(() => {
			timer = void 0;
			if (!running || gen !== generation) return;
			tick(gen);
		}, delayMs);
	};
	const finish = (next, reason, message) => {
		running = false;
		clearTimer();
		state = next;
		if (reason !== void 0) lastReason = reason;
		lastMessage = message;
		emit();
	};
	const stop = (reason) => {
		if (!running) return;
		finish("stopped", reason, "已停止：" + reason);
	};
	async function tick(gen) {
		if (!running || gen !== generation) return;
		state = "thinking";
		lastMessage = "思考中…";
		emit();
		const roundStartedAt = now();
		let round;
		try {
			round = await deps.runRound();
		} catch (e) {
			round = {
				kind: "failed",
				reason: "exception",
				message: e instanceof Error ? e.message : String(e)
			};
		}
		lastRoundMs = now() - roundStartedAt;
		if (!running || gen !== generation) return;
		if (round.kind === "stopped") {
			finish("stopped", round.reason, "已停止：" + round.reason);
			return;
		}
		if (round.kind === "planned") {
			rounds++;
			consecutiveFailures = 0;
			idleRounds = 0;
			lastReason = void 0;
			state = "waiting";
			lastMessage = (round.executed ? "执行了：" : "空跑：") + round.thought;
			emit();
			if (rounds >= maxRounds) {
				finish("stopped", "round-cap", `到上限了（${maxRounds} 轮），先停`);
				return;
			}
			schedule(intervalMs);
			return;
		}
		if (round.kind === "skipped" && round.reason === "window-not-allowed") {
			state = "waiting";
			lastMessage = "不在白名单窗口：" + (round.detail ?? "（无标题）");
			emit();
			schedule(intervalMs);
			return;
		}
		if (round.kind === "skipped" && round.reason === "model-noop") {
			idleRounds++;
			state = "waiting";
			lastMessage = "观望：" + (round.detail ?? "模型选择不动") + `（第 ${idleRounds} 次）`;
			emit();
			if (idleRounds >= 8) {
				finish("stopped", "model-noop-limit", "连续 8 次没有可执行动作，先停（模型认为现在无事可做）");
				return;
			}
			schedule(2500);
			return;
		}
		consecutiveFailures++;
		idleRounds = 0;
		const reason = round.kind === "skipped" ? round.reason : round.reason;
		const detail = round.kind === "skipped" ? round.detail ?? round.reason : round.message;
		if (consecutiveFailures >= failureLimit) {
			finish("error", reason, `连续 ${consecutiveFailures} 次没进展，先停：${detail}`);
			return;
		}
		state = "waiting";
		lastMessage = "没进展（" + detail + "），再试一次…";
		emit();
		schedule(failureDelayMs);
	}
	return {
		start: () => {
			if (running) return;
			generation++;
			running = true;
			rounds = 0;
			consecutiveFailures = 0;
			idleRounds = 0;
			startedAtMs = now();
			lastReason = void 0;
			state = "waiting";
			lastMessage = "准备中…";
			emit();
			const gen = generation;
			timer = setTimeoutFn(() => {
				timer = void 0;
				if (!running || gen !== generation) return;
				tick(gen);
			}, 0);
		},
		stop,
		snapshot
	};
}

//#endregion
//#region src/host/hotkey.ts
const DEFAULT_VOICE_SHORTCUT = "Alt+V";
/** 修饰键虚拟码 */
const VK$1 = {
	ctrl: 17,
	alt: 18,
	shift: 16,
	winLeft: 91,
	winRight: 92
};
/** 具名主键 → VK */
const NAMED_KEYS = {
	space: 32,
	enter: 13,
	return: 13,
	tab: 9,
	esc: 27,
	escape: 27,
	backspace: 8,
	delete: 46,
	insert: 45,
	home: 36,
	end: 35,
	pageup: 33,
	pagedown: 34,
	arrowleft: 37,
	left: 37,
	arrowup: 38,
	up: 38,
	arrowright: 39,
	right: 39,
	arrowdown: 40,
	down: 40,
	"`": 192,
	backquote: 192,
	"-": 189,
	minus: 189,
	"=": 187,
	equal: 187,
	"[": 219,
	bracketleft: 219,
	"]": 221,
	bracketright: 221,
	"\\": 220,
	backslash: 220,
	";": 186,
	semicolon: 186,
	"'": 222,
	quote: 222,
	",": 188,
	comma: 188,
	".": 190,
	period: 190,
	"/": 191,
	slash: 191
};
/** 修饰键写法（页面与宿主共用一套语义） */
const MOD_ALIASES = {
	alt: "alt",
	ctrl: "ctrl",
	control: "ctrl",
	shift: "shift",
	meta: "win",
	cmd: "win",
	win: "win",
	super: "win"
};
/** 主键名 → VK（不认识 → undefined） */
function resolveMainVk(key) {
	if (/^[a-z]$/.test(key)) return 65 + (key.charCodeAt(0) - 97);
	if (/^[0-9]$/.test(key)) return 48 + Number(key);
	const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
	if (fn !== null) return 112 + (Number(fn[1]) - 1);
	return NAMED_KEYS[key];
}
function parseHotkey(text) {
	const raw = typeof text === "string" ? text.trim() : "";
	if (raw === "") return {
		ok: false,
		message: "快捷键为空"
	};
	const parts = raw.split("+").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
	if (parts.length === 0) return {
		ok: false,
		message: "快捷键为空"
	};
	const key = parts[parts.length - 1];
	const modParts = parts.slice(0, -1);
	if (key === "") return {
		ok: false,
		message: "快捷键缺少主键"
	};
	if (MOD_ALIASES[key] !== void 0) return {
		ok: false,
		message: "主键不能是修饰键（写成 " + raw + "+X 这种形式）"
	};
	const spec = {
		vk: 0,
		alt: false,
		ctrl: false,
		shift: false,
		win: false
	};
	for (const part of modParts) {
		const mod = MOD_ALIASES[part];
		if (mod === void 0) return {
			ok: false,
			message: "不认识的修饰键：" + part
		};
		spec[mod] = true;
	}
	const vk = resolveMainVk(key);
	if (vk === void 0) return {
		ok: false,
		message: "系统级热键暂不支持这个主键：" + key
	};
	spec.vk = vk;
	const displayMods = [
		spec.ctrl ? "Ctrl" : "",
		spec.alt ? "Alt" : "",
		spec.shift ? "Shift" : "",
		spec.win ? "Win" : ""
	].filter((part) => part !== "");
	const displayKey = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
	return {
		ok: true,
		spec,
		display: [...displayMods, displayKey].join("+")
	};
}
/** 轮询间隔（ms）：20~30ms 是「手感即时」与「CPU 可忽略」的折中 */
const POLL_MS = 25;
function startHotkeyWatcher(spec, onEvent) {
	let alive = false;
	if (process.platform !== "win32") {
		console.warn("[dsh-whale-girl] 全局语音热键只支持 Windows（当前平台：" + process.platform + "）");
		return {
			stop: () => {},
			running: () => false,
			ready: () => false
		};
	}
	const bool = (value) => value ? "true" : "false";
	const cs = [
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class DshVoiceHotkeyMonitor {",
		"  [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);",
		"  static bool D(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }",
		"  public static bool Hit() {",
		"    if (!D(" + String(spec.vk) + ")) return false;",
		"    if (D(" + String(VK$1.ctrl) + ") != " + bool(spec.ctrl) + ") return false;",
		"    if (D(" + String(VK$1.alt) + ") != " + bool(spec.alt) + ") return false;",
		"    if (D(" + String(VK$1.shift) + ") != " + bool(spec.shift) + ") return false;",
		"    bool win = D(" + String(VK$1.winLeft) + ") || D(" + String(VK$1.winRight) + ");",
		"    if (win != " + bool(spec.win) + ") return false;",
		"    return true;",
		"  }",
		"}"
	].join(" ");
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${cs.replace(/'/g, "''")}' | Out-Null
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$last = $false
while ($true) {
  $hit = [DshVoiceHotkeyMonitor]::Hit()
  if ($hit -ne $last) {
    if ($hit) { [Console]::Out.WriteLine('DOWN') } else { [Console]::Out.WriteLine('UP') }
    [Console]::Out.Flush()
    $last = $hit
  }
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;
	const scriptPath$1 = join(tmpdir(), `dsh-voice-hotkey-${process.pid}-${Date.now()}.ps1`);
	writeFileSync(scriptPath$1, script, "utf8");
	/**
	* spawn 本身可能**同步抛出**（不只是异步 error 事件）。
	*
	* 实测踩到：在受限环境里 `spawn()` 直接抛 `EPERM`，而这里原本没有 try/catch，
	* 于是异常一路上传到 `apply()` → `ctx.effect()`，插件激活失败 →
	* **DSH 整个起不来**（见 docs/ROADMAP.md 坑 7：启动失败会触发回滚，
	* 连模型配置、权限预设、皮肤一起被清掉）。
	*
	* 全局语音热键只是锦上添花的能力：它起不来时应该只降级（热键不可用、
	* 按钮仍能录音），绝不能让宿主启动失败。异步的 error 事件本来就只打日志，
	* 这里补上同步路径，让两条路的口径一致。
	*/
	let child;
	try {
		child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath$1
		], { windowsHide: true });
	} catch (error) {
		alive = false;
		console.warn("[dsh-whale-girl] 全局语音热键监听启动失败（进程起不来）：" + (error instanceof Error ? error.message : String(error)) + "——热键不可用，但录音按钮与页面快捷键仍然工作");
		return {
			stop: () => {},
			running: () => false,
			ready: () => false
		};
	}
	alive = true;
	let ready = false;
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (process.env.DSH_HOTKEY_DEBUG === "1") console.log("[hotkey] line=" + JSON.stringify(trimmed));
			if (trimmed === "READY") {
				ready = true;
				continue;
			}
			if (trimmed === "DOWN") onEvent({
				type: "down",
				atMs: Date.now()
			});
			else if (trimmed === "UP") onEvent({
				type: "up",
				atMs: Date.now()
			});
		}
	});
	child.stderr.on("data", (chunk) => {
		if (process.env.DSH_HOTKEY_DEBUG === "1") console.log("[hotkey] " + chunk.toString("utf8").trim());
	});
	child.on("error", (error) => {
		alive = false;
		console.warn("[dsh-whale-girl] 全局语音热键监听启动失败：" + error.message);
	});
	child.on("exit", () => {
		alive = false;
	});
	let stopped = false;
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			alive = false;
			try {
				child.kill();
			} catch {}
			try {
				unlinkSync(scriptPath$1);
			} catch {}
		},
		running: () => alive && !stopped,
		ready: () => ready
	};
}
const HOTKEY_STREAM_PATH = "/voice/hotkey/stream";
function createHotkeyHub() {
	const clients = new Set();
	const heartbeat = setInterval(() => {
		for (const client of clients) try {
			client.write(": ping\n\n");
		} catch {
			clients.delete(client);
		}
	}, 15e3);
	heartbeat.unref?.();
	const write = (client, frame) => {
		try {
			client.write(frame);
		} catch {
			clients.delete(client);
		}
	};
	return {
		subscribe: (res, ready) => {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no"
			});
			res.flushHeaders?.();
			clients.add(res);
			write(res, "event: ready\ndata: " + JSON.stringify(ready()) + "\n\n");
			const drop = () => {
				clients.delete(res);
			};
			res.on("close", drop);
			res.on("error", drop);
			return drop;
		},
		broadcast: (event) => {
			const frame = "event: hotkey\ndata: " + JSON.stringify(event) + "\n\n";
			for (const client of clients) write(client, frame);
		},
		clients: () => clients.size,
		close: () => {
			for (const client of clients) try {
				client.end();
			} catch {}
			clients.clear();
			clearInterval(heartbeat);
		}
	};
}

//#endregion
//#region src/host/game-skill.ts
const LOSS_LIMIT = 3;
const MAX_SKILLS = 200;
/** 触发关键词上限：太多会导致永远匹配不上 */
const MAX_TRIGGERS = 6;
/** 从画面描述里提取关键词（去掉标点与常见虚词） */
const STOP_WORDS = new Set([
	"的",
	"了",
	"是",
	"在",
	"有",
	"和",
	"与",
	"就",
	"都",
	"而",
	"及",
	"或",
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"of",
	"to",
	"in",
	"on",
	"and",
	"or"
]);
const STOP_CHARS = new Set([
	"的",
	"了",
	"是",
	"在",
	"有",
	"和",
	"与",
	"就",
	"都",
	"而",
	"及",
	"或",
	"着",
	"过",
	"吧",
	"呢",
	"啊"
]);
/**
* 这个词块是不是「全是虚词」。
*
* 为什么需要：中文没有空格，`的了是` 这种串会整个被当成一个词。
* 只按 STOP_WORDS 整词过滤挡不住它——它既不是单个虚词，也是完全无信息量的串。
* 这类词块当触发条件会让技能永远匹配不上（或者匹配错），所以整块丢掉。
*/
function isAllStopChars(token) {
	for (const ch of token) if (!STOP_CHARS.has(ch)) return false;
	return true;
}
function extractTriggers(description) {
	const words = description.replace(/[，。！？、；：「」【】（）《》,.!?;:()[\]<>'"]/g, " ").split(/\s+/).map((w) => w.trim()).filter((w) => w !== "" && !STOP_WORDS.has(w) && w.length >= 2 && !isAllStopChars(w));
	const seen = new Set();
	const out = [];
	for (const w of words) {
		if (seen.has(w)) continue;
		seen.add(w);
		out.push(w);
		if (out.length >= MAX_TRIGGERS) break;
	}
	return out;
}
function makeSkillId(existing) {
	let n = existing.length + 1;
	const taken = new Set(existing.map((s) => s.id));
	while (taken.has(`s${n}`)) n++;
	return `s${n}`;
}
function createSkill(description, actions, existing, now = Date.now()) {
	const triggers = extractTriggers(description);
	if (triggers.length === 0 || actions.length === 0) return void 0;
	return {
		id: makeSkillId(existing),
		name: triggers.slice(0, 3).join("-"),
		triggers,
		actions,
		wins: 1,
		losses: 0,
		createdAt: now,
		lastUsedAt: now
	};
}
function matchSkill(skills, description) {
	const haystack = description.toLowerCase();
	const candidates = skills.filter((s) => {
		if (s.triggers.length === 0) return false;
		if (s.losses >= LOSS_LIMIT) return false;
		return s.triggers.every((t) => haystack.includes(t.toLowerCase()));
	});
	if (candidates.length === 0) return void 0;
	return candidates.sort((a, b) => b.wins - a.wins || b.lastUsedAt - a.lastUsedAt)[0];
}
function scoreSkill(skill, ok, now = Date.now()) {
	if (ok) skill.wins++;
	else skill.losses++;
	skill.lastUsedAt = now;
	return skill.losses < LOSS_LIMIT;
}
function pruneSkills(skills) {
	const alive = skills.filter((s) => s.losses < LOSS_LIMIT);
	if (alive.length <= MAX_SKILLS) return alive;
	return alive.sort((a, b) => b.wins - a.wins || b.lastUsedAt - a.lastUsedAt).slice(0, MAX_SKILLS);
}

//#endregion
//#region src/host/game-memory.ts
const GENRE_MEMORY_CAP = {
	"turn-based": 500,
	"grand-strategy": 2e3,
	tactics: 800,
	rpg: 1500,
	action: 300,
	custom: 500
};
const MIN_CAP = 20;
const MAX_CAP = 2e4;
function createGameSession(gameTitle, cap) {
	return {
		gameTitle,
		startedAt: Date.now(),
		steps: [],
		cap: Math.max(MIN_CAP, Math.min(MAX_CAP, Math.round(cap)))
	};
}
function recordStep(session, step) {
	session.steps.push({
		...step,
		screen: step.screen.slice(0, 400),
		plan: step.plan.slice(0, 200)
	});
	if (session.steps.length > session.cap) session.steps.splice(0, session.steps.length - session.cap);
}
function recentContext(session, recent = 12) {
	const steps = session.steps.slice(-recent);
	if (steps.length === 0) return "";
	return steps.map((s, i) => {
		const tag = s.outcome === "ok" ? "" : `[${s.outcome}]`;
		return `${i + 1}. 画面：${s.screen} → 决定：${s.plan}${tag}`;
	}).join("\n");
}
function compressSession(session, target) {
	const total = session.steps.length;
	if (total === 0) return `（和主人玩了${session.gameTitle}，还没做什么）`;
	const executed = session.steps.filter((s) => s.executed).length;
	const dry = session.steps.filter((s) => s.outcome === "dry").length;
	const rejected = session.steps.filter((s) => s.outcome === "rejected").length;
	const stopped = session.steps.filter((s) => s.outcome === "stopped").length;
	const stats = [`共 ${total} 步`, `实际执行 ${executed} 步`];
	if (dry > 0) stats.push(`空跑 ${dry} 步（未按键）`);
	if (rejected > 0) stats.push(`被白名单拒绝 ${rejected} 次`);
	if (stopped > 0) stats.push(`急停 ${stopped} 次`);
	const keep = Math.max(1, Math.min(target, 5));
	const tail = session.steps.slice(-keep).map((s) => s.plan);
	return `（和主人玩了${session.gameTitle}：${stats.join("，")}。最近做的：${tail.join(" → ")}）`;
}
function shouldCompress(session) {
	return session.steps.length > 0;
}

//#endregion
//#region src/host/game-profile.ts
const GENRE_PRESETS = {
	"turn-based": {
		上: "up",
		下: "down",
		左: "left",
		右: "right",
		确认: "enter",
		取消: "esc",
		菜单: "tab"
	},
	"grand-strategy": {
		暂停: "space",
		加速: "a",
		减速: "s",
		确认: "enter",
		取消: "esc",
		菜单: "esc"
	},
	tactics: {
		上: "up",
		下: "down",
		左: "left",
		右: "right",
		确认: "enter",
		取消: "esc",
		结束回合: "space"
	},
	rpg: {
		前: "w",
		后: "s",
		左: "a",
		右: "d",
		交互: "e",
		确认: "enter",
		取消: "esc",
		菜单: "tab"
	},
	action: {
		前: "w",
		后: "s",
		左: "a",
		右: "d",
		攻击: "j",
		跳跃: "space",
		交互: "e",
		取消: "esc"
	}
};
function profileIdFromTitle(title) {
	const cleaned = title.trim().toLowerCase().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "-");
	return cleaned === "" ? "untitled" : cleaned.slice(0, 60);
}
function normalizeProfile(raw) {
	const title = typeof raw?.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : "未命名游戏";
	const genre = raw?.genre === "turn-based" || raw?.genre === "grand-strategy" || raw?.genre === "tactics" || raw?.genre === "rpg" || raw?.genre === "action" || raw?.genre === "custom" ? raw.genre : "custom";
	const explicitKeys = {};
	if (raw?.keys && typeof raw.keys === "object") {
		for (const [action, key] of Object.entries(raw.keys)) if (typeof key === "string" && key.trim() !== "") explicitKeys[action] = key.trim();
	}
	const preset = genre === "custom" ? {} : GENRE_PRESETS[genre];
	const keys = {
		...preset,
		...explicitKeys
	};
	const notes = Array.isArray(raw?.notes) ? raw.notes.filter((n) => typeof n === "string" && n.trim() !== "").map((n) => n.trim()).slice(0, 50) : [];
	const guide = raw?.guide !== void 0 && typeof raw.guide === "object" && raw.guide !== null && typeof raw.guide.query === "string" && typeof raw.guide.summary === "string" ? {
		query: raw.guide.query,
		summary: raw.guide.summary,
		sources: Array.isArray(raw.guide.sources) ? raw.guide.sources.filter((s) => typeof s?.url === "string").map((s) => ({
			...typeof s.title === "string" ? { title: s.title } : {},
			url: s.url
		})).slice(0, 10) : [],
		atMs: typeof raw.guide.atMs === "number" ? raw.guide.atMs : Date.now()
	} : void 0;
	const capRaw = Number(raw?.memoryCap);
	const memoryCap = Number.isFinite(capRaw) && capRaw > 0 ? Math.max(20, Math.min(2e4, Math.round(capRaw))) : void 0;
	return {
		id: typeof raw?.id === "string" && raw.id.trim() !== "" ? profileIdFromTitle(raw.id) : profileIdFromTitle(title),
		title,
		genre,
		keys,
		notes,
		...memoryCap === void 0 ? {} : { memoryCap },
		...guide === void 0 ? {} : { guide }
	};
}
function profileBrief(profile) {
	const lines = [`游戏：${profile.title}（${profile.genre}）`];
	const keys = Object.entries(profile.keys);
	if (keys.length > 0) lines.push("按键：" + keys.map(([action, key]) => `${action}=${key}`).join(" "));
	if (profile.notes.length > 0) lines.push("要点：" + profile.notes.slice(0, 8).join("；"));
	const guide = profile.guide;
	if (guide !== void 0 && guide.summary.trim() !== "") lines.push("攻略：" + guide.summary.trim().slice(0, 300));
	return lines.join("\n");
}

//#endregion
//#region src/host/game-guide.ts
/** 单次检索超时：搜索服务偶尔会很慢，别把整轮游戏卡住 */
const TIMEOUT_MS = 12e3;
async function searchGuide(web, game, extra = "操作 按键 新手攻略") {
	const query = `${game} ${extra}`.trim();
	if (web === void 0 || typeof web.search !== "function") return {
		ok: false,
		reason: "web-unavailable",
		message: "没有可用的联网搜索服务"
	};
	if (game.trim() === "") return {
		ok: false,
		reason: "no-game",
		message: "不知道是哪个游戏，没法查"
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const result = await web.search({
			query,
			maxResults: 5
		}, controller.signal);
		const sources = (result.sources ?? []).filter((s) => typeof s.url === "string" && s.url !== "").slice(0, 5).map((s) => ({
			...typeof s.title === "string" ? { title: s.title } : {},
			url: s.url
		}));
		const rawSummary = typeof result.content === "string" && result.content.trim() !== "" ? result.content.trim() : (result.sources ?? []).map((s) => [s.title, s.snippet].filter((x) => typeof x === "string" && x !== "").join("：")).filter((s) => s !== "").join("\n");
		if (rawSummary === "") return {
			ok: false,
			reason: "empty",
			message: "搜到了但没有任何内容"
		};
		return {
			ok: true,
			query,
			summary: rawSummary.slice(0, 300),
			sources,
			atMs: Date.now()
		};
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/abort/i.test(message)) return {
			ok: false,
			reason: "timeout",
			message: `检索超时（${TIMEOUT_MS} ms）`
		};
		return {
			ok: false,
			reason: "search-failed",
			message
		};
	} finally {
		clearTimeout(timer);
	}
}
function shouldSearchGuide(opts) {
	const threshold = Math.max(1, opts.stuckThreshold ?? 3);
	const cooldown = Math.max(0, opts.cooldownMs ?? 10 * 60 * 1e3);
	const now = opts.now ?? Date.now();
	if (opts.stuckRounds < threshold) return false;
	if (opts.lastSearchAt !== void 0 && now - opts.lastSearchAt < cooldown) return false;
	if (opts.hasGuide) return false;
	return true;
}

//#endregion
//#region src/host/dsh-session.ts
function buildSeedEvent(text, now = Date.now()) {
	const message = createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: { kind: "user" }
	});
	return {
		type: "user/message",
		seq: 0,
		time: now,
		data: message,
		surfaceOp: "append"
	};
}
function makeSessionId(prefix = "whale", now = Date.now()) {
	return `${prefix}-${now.toString(36)}`;
}
async function createTaskSession(agents, task, opts = {}) {
	const text = task.trim();
	if (text === "") return {
		ok: false,
		reason: "empty-task",
		message: "没有要做的任务"
	};
	if (agents === void 0 || typeof agents.create !== "function") return {
		ok: false,
		reason: "agents-unavailable",
		message: "Agent 服务不可用，建不了会话"
	};
	const sessionId = makeSessionId("whale", opts.now ?? Date.now());
	const title = text.length > 24 ? text.slice(0, 24) + "…" : text;
	try {
		const handle = await agents.create({
			sessionId,
			meta: {
				...opts.cwd === void 0 || opts.cwd === "" ? {} : { cwd: opts.cwd },
				isSeeded: true
			},
			inheritedEventCount: 0,
			seed: [buildSeedEvent(text, opts.now ?? Date.now())],
			...opts.provider === void 0 || opts.model === void 0 ? {} : { agentOptions: {
				provider: opts.provider,
				model: opts.model
			} }
		});
		return {
			ok: true,
			sessionId: handle.agent.id,
			title
		};
	} catch (e) {
		return {
			ok: false,
			reason: "create-failed",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}

//#endregion
//#region src/host/task-loop.ts
const DEFAULT_TASK_CONFIG = {
	allowedTitles: [],
	maxSteps: 20,
	dryRun: true
};
function taskPrompt(goal, step, maxSteps) {
	return `你在替主人操作电脑，完成这个任务：${goal}

这是第 ${step} / ${maxSteps} 步。你会看到当前屏幕画面。

请判断**下一步做什么**，并且只输出**一行**，格式必须是下面之一：

click X Y            —— 用鼠标左键点屏幕坐标 (X, Y)
rclick X Y           —— 右键点击
drag X1 Y1 X2 Y2     —— 在 (X1,Y1) 按下左键、拖到 (X2,Y2) 松开（拖拽/战棋移动）
key NAME             —— 按一下某个键（NAME 用英文：w a s d space enter esc tab up down left right 0-9）
keydown NAME         —— 按住
keyup NAME           —— 松开
move X Y             —— 只移动鼠标
done 说明            —— **任务已经完成了**，用一句话说结果
noop 原因            —— 这一步什么都不做

规则：
1. 一次只输出**一个**动作。
2. 坐标用画面像素，左上角是 (0,0)。
3. **看不清、不确定、界面还没加载好 → 一律 noop**。乱点比不动危险得多。
4. 确认目标真的达成了才输出 done。没达成不要提前 done。
5. 不要解释，不要输出第二行，不要用 Markdown。`;
}
function parseTaskDone(raw) {
	const text = raw.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, "$1").replace(/[`*_#>|]/g, "").trim();
	const first = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
	if (!first.toLowerCase().startsWith("done")) return void 0;
	return first.slice(4).trim() || "完成了";
}
const STUCK_LIMIT = 4;
function createTaskState() {
	return {
		steps: 0,
		stuck: 0,
		log: []
	};
}
function advanceTaskState(state, description, changed) {
	state.steps += 1;
	state.stuck = changed ? 0 : state.stuck + 1;
	state.log.push(description);
	if (state.log.length > 10) state.log.splice(0, state.log.length - 10);
	return state;
}
function shouldGiveUp(state, maxSteps) {
	if (state.steps >= maxSteps) return {
		giveUp: true,
		reason: `已经走了 ${state.steps} 步还没完成`
	};
	if (state.stuck >= STUCK_LIMIT) return {
		giveUp: true,
		reason: `连续 ${state.stuck} 步画面没有变化，可能卡住了`
	};
	return {
		giveUp: false,
		reason: ""
	};
}

//#endregion
//#region src/host/task-router.ts
/**
* 复杂任务的标志词。
*
* 出现这些就交给 DSH 会话——它们意味着**多步骤、要产出文件、要访问代码库**，
* 不是一次点击能完成的。
*/
/**
* 明确要求「在 DSH 里新建会话」的说法。
*
* 主人定的规则：**只有明确提到这些**才去建会话；
* 其余情况要么是自己能动手的活儿，要么就是聊天——聊天就好好聊天。
*/
const SESSION_HINTS = [
	"新建一个项目",
	"建一个项目",
	"做一个项目",
	"新建一个会话",
	"开一个新会话",
	"建个工程",
	"新建项目",
	"新建项目",
	"新开项目",
	"建个项目",
	"建个新项目",
	"新建会话",
	"新开会话",
	"新建dsh",
	"dsh会话",
	"dsh项目",
	"在dsh",
	"开个会话",
	"起个会话"
];
function routeTask(text) {
	const raw = text.trim();
	if (raw === "") return {
		kind: "chat",
		reason: "空话"
	};
	const lower = raw.toLowerCase();
	const sessionHint = SESSION_HINTS.find((h) => lower.includes(h));
	if (sessionHint !== void 0) return {
		kind: "session",
		prompt: raw,
		reason: `你提到了「${sessionHint}」`
	};
	const urlMatch = raw.match(/(?:打开|访问|去到?)\s*((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)/);
	if (urlMatch !== null) {
		let url = urlMatch[1];
		if (!/^https?:\/\//i.test(url)) url = "https://" + url;
		return {
			kind: "self",
			action: {
				do: "open-url",
				url
			},
			reason: "打开网址"
		};
	}
	const msgMatch = raw.match(/(?:打开|用)?\s*([^\s，。]{1,10})\s*(?:给|跟|向)\s*([^\s，。]{1,20})\s*(?:发|说|告诉)(?:条|一条|一个|个)?(?:信息|消息|话|一句)?\s*(.*)/);
	if (msgMatch !== null) return {
		kind: "self",
		action: {
			do: "send-message",
			app: msgMatch[1].trim(),
			to: msgMatch[2].trim(),
			text: msgMatch[3].trim()
		},
		reason: "发消息"
	};
	const musicMatch = raw.match(/(?:播放|放一首|放首|听)\s*(.{1,40})/);
	if (musicMatch !== null && /音乐|歌|网易云|QQ音乐/.test(raw)) return {
		kind: "self",
		action: {
			do: "play-music",
			what: musicMatch[1].trim()
		},
		reason: "放音乐"
	};
	const searchMatch = raw.match(/(?:搜索|搜一下|查一下|帮我查)\s*(.{1,60})/);
	if (searchMatch !== null) return {
		kind: "self",
		action: {
			do: "search-web",
			query: searchMatch[1].trim()
		},
		reason: "搜索"
	};
	const focusMatch = raw.match(/(?:切到|切换到|回到)\s*(.{1,30})/);
	if (focusMatch !== null) return {
		kind: "self",
		action: {
			do: "focus-window",
			target: focusMatch[1].trim()
		},
		reason: "切窗口"
	};
	const openMatch = raw.match(/(?:帮我)?(?:打开|启动|运行)\s*([^\s，。给发说]{1,20})\s*$|(?:帮我)?(?:打开|启动|运行)\s*([^\s，。给发说]{1,20})/);
	if (openMatch !== null) {
		const appName = (openMatch[1] ?? openMatch[2] ?? "").trim();
		if (appName !== "") return {
			kind: "self",
			action: {
				do: "open-app",
				target: appName
			},
			reason: "打开应用"
		};
	}
	return {
		kind: "chat",
		reason: "没有明确动作意图"
	};
}

//#endregion
//#region src/host/messaging.ts
const PENDING_TTL_MS = 5 * 60 * 1e3;
/** 确认词 */
const CONFIRM_WORDS = [
	"发",
	"发吧",
	"发送",
	"确认",
	"确认发送",
	"发出去",
	"发给他",
	"发给她",
	"发过去"
];
/** 取消词 */
const CANCEL_WORDS = [
	"不发",
	"别发",
	"取消",
	"算了",
	"不发了",
	"取消发送"
];
function isConfirm(text) {
	const t = text.replace(/[，。！？、；：\s]/g, "").trim();
	return CONFIRM_WORDS.includes(t);
}
function isCancel(text) {
	const t = text.replace(/[，。！？、；：\s]/g, "").trim();
	return CANCEL_WORDS.includes(t);
}
function isExpired(pending, now = Date.now()) {
	return now - pending.at > PENDING_TTL_MS;
}
function describePending(pending) {
	if (pending.text.trim() === "") return `要打开${pending.app}里和「${pending.to}」的会话，但你没说发什么。要发什么？`;
	return `确认一下：发给${pending.app}的「${pending.to}」，内容是「${pending.text}」。说「发」我就发，说「不发」就取消。`;
}
function planSend(pending) {
	const steps = [
		{
			kind: "key",
			key: "f",
			modifiers: ["ctrl"]
		},
		{
			kind: "clipboard",
			text: pending.to
		},
		{
			kind: "key",
			key: "v",
			modifiers: ["ctrl"]
		},
		{
			kind: "key",
			key: "enter"
		}
	];
	const body = pending.text.trim();
	if (body !== "") {
		steps.push({
			kind: "clipboard",
			text: body
		});
		steps.push({
			kind: "key",
			key: "v",
			modifiers: ["ctrl"]
		});
		steps.push({
			kind: "key",
			key: "enter"
		});
	}
	return steps;
}

//#endregion
//#region src/host/input.ts
/**
* 键名 → Windows 虚拟键码。
*
* 只收「游戏与桌面导航会用到」的那一批；不提供「随便填字符串」的后门
* （那等于把键盘交给模型，风险不可控）。
*/
const VK = {
	up: 38,
	down: 40,
	left: 37,
	right: 39,
	space: 32,
	enter: 13,
	esc: 27,
	tab: 9,
	shift: 16,
	ctrl: 17,
	alt: 18,
	a: 65,
	b: 66,
	c: 67,
	d: 68,
	e: 69,
	f: 70,
	g: 71,
	h: 72,
	i: 73,
	j: 74,
	k: 75,
	l: 76,
	m: 77,
	n: 78,
	o: 79,
	p: 80,
	q: 81,
	r: 82,
	s: 83,
	t: 84,
	u: 85,
	v: 86,
	w: 87,
	x: 88,
	y: 89,
	z: 90,
	"0": 48,
	"1": 49,
	"2": 50,
	"3": 51,
	"4": 52,
	"5": 53,
	"6": 54,
	"7": 55,
	"8": 56,
	"9": 57
};
function resolveKey(name, extra) {
	const key = name.trim().toLowerCase();
	if (key === "") return void 0;
	if (extra !== void 0 && typeof extra[key] === "number" && Number.isFinite(extra[key])) {
		const v = Math.trunc(extra[key]);
		if (v > 0 && v < 256) return v;
	}
	return VK[key];
}
/**
* PowerShell 前置：注册 user32 的 P/Invoke。
*
* **必须是单行字符串形式的 `-TypeDefinition`**。
*  - here-string（`@'...'@`）在这条 stdin 通道上会静默失效（退出码 0、stdout 空）；
*  - `-MemberDefinition` 又不支持嵌套结构体与辅助函数。
* 所以把整段 C# 压成一行、用单引号包起来传进去。
*/
const CS_TYPE = [
	"using System;",
	"using System.Runtime.InteropServices;",
	"using System.Text;",
	"public static class DshInApi {",
	"  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
	"  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
	"  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }",
	"  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }",
	"  [DllImport(\"user32.dll\", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);",
	"  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
	"  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
	"  [DllImport(\"user32.dll\")] public static extern int GetWindowTextLength(IntPtr h);",
	"  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);",
	"  public static string ForegroundTitle() {",
	"    IntPtr h = GetForegroundWindow();",
	"    int len = GetWindowTextLength(h);",
	"    StringBuilder sb = new StringBuilder(len + 2);",
	"    GetWindowText(h, sb, sb.Capacity);",
	"    return sb.ToString();",
	"  }",
	"  public static void Mouse(uint down, uint up) {",
	"    INPUT[] arr = new INPUT[2];",
	"    arr[0].type = 0; arr[0].u.mi.dwFlags = down;",
	"    arr[1].type = 0; arr[1].u.mi.dwFlags = up;",
	"    SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));",
	"  }",
	"  public static void Key(int vk, bool up) {",
	"    INPUT[] arr = new INPUT[1];",
	"    arr[0].type = 1;",
	"    arr[0].u.ki.wVk = (ushort)vk;",
	"    arr[0].u.ki.dwFlags = up ? 2u : 0u;",
	"    SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));",
	"  }",
	"}"
].join(" ");
const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
# 窗口标题常含中文：不显式指定 UTF-8 的话，Node 侧拿到的是乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition '${CS_TYPE.replace(/'/g, "''")}' | Out-Null
`;
/** 跑一段 PowerShell（脚本从 stdin 送）。 */
function runPowerShell(script) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"-"
		], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("注入超时"));
		}, 15e3);
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf8");
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`注入脚本退出码 ${String(code)}：${stderr.trim().slice(0, 300)}`));
				return;
			}
			resolvePromise({
				stdout,
				stderr
			});
		});
		child.stdin.end(script, "utf8");
	});
}
async function foregroundWindowTitle() {
	const { stdout } = await runPowerShell(`${PS_PRELUDE}\n$b = [System.Text.Encoding]::UTF8.GetBytes([DshInApi]::ForegroundTitle())\n[Console]::Out.Write([Convert]::ToBase64String($b))`);
	const b64 = stdout.trim();
	if (b64 === "") return "";
	try {
		return Buffer.from(b64, "base64").toString("utf8");
	} catch {
		return "";
	}
}
async function performInput(action, guard) {
	const started = Date.now();
	if (guard.allowedTitles.length > 0) try {
		const title = await foregroundWindowTitle();
		const matcher = guard.matchesTitle ?? ((current, allowed$1) => allowed$1.some((t) => t !== "" && current.includes(t)));
		const allowed = matcher(title, guard.allowedTitles);
		if (!allowed) return {
			ok: false,
			reason: "window-not-allowed",
			message: `前台窗口不在白名单里（当前：${title === "" ? "无标题" : title}）`
		};
	} catch (e) {
		return {
			ok: false,
			reason: "guard-failed",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	let body = "";
	switch (action.kind) {
		case "move":
			body = `[void][DshInApi]::SetCursorPos(${Math.round(action.x)}, ${Math.round(action.y)})`;
			break;
		case "click": {
			const btn = action.button ?? "left";
			const down = btn === "right" ? "0x08" : "0x02";
			const up = btn === "right" ? "0x10" : "0x04";
			body = [
				`[void][DshInApi]::SetCursorPos(${Math.round(action.x)}, ${Math.round(action.y)})`,
				"Start-Sleep -Milliseconds 60",
				`[DshInApi]::Mouse(${down}, 0x00)`,
				"Start-Sleep -Milliseconds 60",
				`[DshInApi]::Mouse(0x00, ${up})`,
				"Start-Sleep -Milliseconds 40"
			].join("\n");
			break;
		}
		case "drag": {
			const x1 = Math.round(action.fromX);
			const y1 = Math.round(action.fromY);
			const x2 = Math.round(action.toX);
			const y2 = Math.round(action.toY);
			const STEPS = 6;
			const steps = [];
			for (let i = 1; i <= STEPS; i++) {
				const x = Math.round(x1 + (x2 - x1) * i / STEPS);
				const y = Math.round(y1 + (y2 - y1) * i / STEPS);
				steps.push(`[void][DshInApi]::SetCursorPos(${x}, ${y})`, "Start-Sleep -Milliseconds 35");
			}
			body = [
				`[void][DshInApi]::SetCursorPos(${x1}, ${y1})`,
				"Start-Sleep -Milliseconds 80",
				"[DshInApi]::Mouse(0x02, 0x00)",
				"Start-Sleep -Milliseconds 80",
				...steps,
				"Start-Sleep -Milliseconds 80",
				"[DshInApi]::Mouse(0x00, 0x04)",
				"Start-Sleep -Milliseconds 60"
			].join("\n");
			break;
		}
		case "key": {
			const vk = resolveKey(action.key, guard.extraKeys);
			if (vk === void 0) return {
				ok: false,
				reason: "unknown-key",
				message: `不认识的键：${action.key}`
			};
			const hold = Math.max(20, Math.min(5e3, action.holdMs ?? 60));
			body = `[DshInApi]::Key(${vk}, $false)\nStart-Sleep -Milliseconds ${hold}\n[DshInApi]::Key(${vk}, $true)`;
			break;
		}
		case "keyDown": {
			const vk = resolveKey(action.key, guard.extraKeys);
			if (vk === void 0) return {
				ok: false,
				reason: "unknown-key",
				message: `不认识的键：${action.key}`
			};
			body = `[DshInApi]::Key(${vk}, $false)`;
			break;
		}
		case "keyUp": {
			const vk = resolveKey(action.key, guard.extraKeys);
			if (vk === void 0) return {
				ok: false,
				reason: "unknown-key",
				message: `不认识的键：${action.key}`
			};
			body = `[DshInApi]::Key(${vk}, $true)`;
			break;
		}
		case "type": {
			if (!/^[\x20-\x7e]{0,200}$/.test(action.text)) return {
				ok: false,
				reason: "unsupported-text",
				message: "只支持可打印 ASCII（中文会走输入法，行为不可控）"
			};
			const escaped = action.text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
			body = `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(escaped)})`;
			break;
		}
		default: return {
			ok: false,
			reason: "unknown-action",
			message: "不支持的动作"
		};
	}
	try {
		await runPowerShell(`${PS_PRELUDE}\n${body}`);
		return {
			ok: true,
			elapsedMs: Date.now() - started
		};
	} catch (e) {
		return {
			ok: false,
			reason: "inject-failed",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}

//#endregion
//#region src/host/chat-format.ts
/** 动作段的标记：「【动作】」「[神态]」「动作：」「--- 动作 ---」都认 */
const ACTION_MARKER = /^\s*(?:【(?:动作|神态|表情|心理|旁白)】|\[(?:动作|神态|表情|心理|旁白)\]|(?:动作|神态|表情|心理|旁白)\s*[:：]|-{2,}\s*(?:动作|神态|表情|心理|旁白)\s*-{2,})/;
/** 整段都是旁白：`（…）` / `(…)` / `【…】` / `*…*` */
function isStageParagraph(paragraph) {
	const p = paragraph.trim();
	if (p === "") return false;
	return /^[（(【\[][\s\S]*[）)】\]]$/.test(p) || /^\*[^*\n]+\*$/.test(p);
}
function splitChatReply(raw) {
	const text = raw.trim();
	if (text === "") return {
		speech: "",
		action: ""
	};
	const speechLines = [];
	const actionLines = [];
	let inAction = false;
	for (const line of text.split(/\r?\n/)) {
		if (ACTION_MARKER.test(line)) {
			inAction = true;
			const rest = line.replace(ACTION_MARKER, "").trim();
			if (rest !== "") actionLines.push(rest);
			continue;
		}
		if (inAction) actionLines.push(line);
		else speechLines.push(line);
	}
	let speech = speechLines.join("\n").trim();
	if (speech !== "") {
		const paragraphs = speech.split(/\n{2,}/).map((paragraph) => {
			let p = paragraph.trim();
			p = p.replace(/^(?:[（(][^）)]{0,200}[）)]\s*)+/, "").trim();
			return p;
		}).filter((paragraph) => paragraph !== "" && !isStageParagraph(paragraph));
		const cleaned = paragraphs.join("\n\n").trim();
		if (cleaned !== "") speech = cleaned;
	}
	if (speech === "" && actionLines.length > 0) return {
		speech: actionLines.join("\n").trim(),
		action: ""
	};
	return {
		speech,
		action: actionLines.join("\n").trim()
	};
}

//#endregion
//#region src/host/memory-io.ts
/** 角色别名：手机端导出常见的中英文各种写法 */
const ROLE_ALIASES = {
	user: "user",
	me: "user",
	human: "user",
	我: "user",
	主人: "user",
	用户: "user",
	assistant: "assistant",
	ai: "assistant",
	bot: "assistant",
	model: "assistant",
	you: "assistant",
	你: "assistant",
	她: "assistant",
	助手: "assistant",
	鲸鱼娘: "assistant"
};
/** 单次导入上限：防止一个 100MB 的 JSON 把内存打爆 */
const MAX_IMPORT = 5e3;
/** 把各种 role 写法归一化；认不出 → undefined */
function normalizeRole(raw) {
	if (typeof raw !== "string") return void 0;
	return ROLE_ALIASES[raw.trim().toLowerCase()] ?? ROLE_ALIASES[raw.trim()];
}
/** 从对象里取正文（content / text / message 都认） */
function messageText(item) {
	for (const key of [
		"content",
		"text",
		"message"
	]) {
		const value = item[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
		if (Array.isArray(value)) {
			const joined = value.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("").trim();
			if (joined !== "") return joined;
		}
	}
	return "";
}
/** 纯文本解析：`我：…` / `你：…` / `User: …` / `Assistant: …`，续行接到上一条 */
function parseText(raw, now) {
	const lines = raw.split(/\r?\n/);
	const messages = [];
	const prefix = /^\s*(我|主人|用户|user|me|human|你|她|助手|ai|assistant|bot|model|鲸鱼娘)\s*[:：]\s*(.*)$/i;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const match = prefix.exec(line);
		if (match) {
			const role = normalizeRole(match[1]);
			const content = match[2].trim();
			if (role !== void 0 && content !== "") messages.push({
				role,
				content,
				ts: now + messages.length
			});
			continue;
		}
		if (messages.length > 0) messages[messages.length - 1].content += "\n" + line.trim();
	}
	if (messages.length === 0) return {
		ok: false,
		message: "没认出对话格式：可以粘贴 JSON，或用「我：… / 你：…」这种一行一句的格式"
	};
	return {
		ok: true,
		messages: messages.slice(0, MAX_IMPORT)
	};
}
function parseMemoryImport(raw, now = Date.now()) {
	let value = raw;
	if (typeof raw === "string") {
		const text = raw.trim();
		if (text === "") return {
			ok: false,
			message: "内容是空的"
		};
		if (text.startsWith("[") || text.startsWith("{")) try {
			value = JSON.parse(text);
		} catch (e) {
			return {
				ok: false,
				message: "JSON 解析失败：" + (e instanceof Error ? e.message : String(e))
			};
		}
		else return parseText(text, now);
	}
	let list;
	if (Array.isArray(value)) list = value;
	else if (value && typeof value === "object") {
		const obj$1 = value;
		for (const key of [
			"messages",
			"data",
			"history",
			"items"
		]) if (Array.isArray(obj$1[key])) {
			list = obj$1[key];
			break;
		}
	}
	if (list === void 0) return {
		ok: false,
		message: "没找到消息数组（支持 {messages:[…]} 或直接是数组）"
	};
	const messages = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const obj$1 = item;
		const role = normalizeRole(obj$1.role ?? obj$1.from ?? obj$1.author);
		const content = messageText(obj$1);
		if (role === void 0 || content === "") continue;
		const tsRaw = Number(obj$1.ts ?? obj$1.time ?? obj$1.timestamp ?? obj$1.createdAt);
		const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : now + messages.length;
		messages.push({
			role,
			content,
			ts
		});
		if (messages.length >= MAX_IMPORT) break;
	}
	if (messages.length === 0) return {
		ok: false,
		message: "一条都没认出来：每条消息需要 role（user/assistant）和 content"
	};
	return {
		ok: true,
		messages
	};
}
function mergeMemory(existing, incoming, cap = 2e3) {
	const byKey = new Map();
	for (const message of [...existing, ...incoming]) {
		if (message.content.trim() === "") continue;
		const key = `${message.ts}|${message.role}|${message.content}`;
		if (!byKey.has(key)) byKey.set(key, message);
	}
	const merged = [...byKey.values()].sort((a, b) => a.ts - b.ts);
	const limited = cap > 0 && merged.length > cap ? merged.slice(-cap) : merged;
	return {
		messages: limited,
		added: Math.max(0, limited.length - existing.length)
	};
}
function exportMemoryPayload(messages) {
	return {
		format: "dsh-whale-girl-memory",
		version: 1,
		exportedAt: new Date().toISOString(),
		messages: messages.map((message) => ({
			role: message.role,
			content: message.content,
			ts: message.ts
		}))
	};
}
/** 中文按二字组切，英文/数字按词切（够用且不需要分词库） */
function tokensOf(text) {
	const lowered = text.toLowerCase();
	const latin = lowered.match(/[a-z0-9]{2,}/g) ?? [];
	const cjk = lowered.replace(/[^\u4e00-\u9fff]/g, "");
	const grams = [];
	for (let i = 0; i + 2 <= cjk.length; i++) grams.push(cjk.slice(i, i + 2));
	return [...new Set([...latin, ...grams])];
}
function selectRelevantMemory(messages, query, options = {}) {
	const tokens = tokensOf(query);
	if (tokens.length === 0) return [];
	const excludeLast = Math.max(0, options.excludeLast ?? 0);
	const limit = Math.max(1, options.limit ?? 6);
	const minScore = Math.max(.1, options.minScore ?? 1);
	const end = Math.max(0, messages.length - excludeLast);
	const corpus = [];
	for (let i = 0; i < end; i++) corpus.push(messages[i].content.toLowerCase());
	const weights = new Map();
	for (const token of tokens) {
		let df = 0;
		for (const content of corpus) if (content.includes(token)) df++;
		weights.set(token, Math.log((corpus.length + 1) / (df + 1)) + .2);
	}
	const scored = [];
	for (let i = 0; i < end; i++) {
		const message = messages[i];
		const content = corpus[i];
		let score = 0;
		for (const token of tokens) if (content.includes(token)) score += weights.get(token) ?? 0;
		if (score >= minScore) scored.push({
			message,
			score
		});
	}
	scored.sort((a, b) => b.score - a.score || b.message.ts - a.message.ts);
	return scored.slice(0, limit).map((entry) => entry.message);
}

//#endregion
//#region src/host/sight-runner.ts
const DEFAULT_SIGHT_CONFIG = {
	enabled: false,
	intervalSec: 60,
	jitterMin: .6,
	jitterMax: 1.6,
	keepSnapshots: 20,
	changeThreshold: .02,
	speak: false,
	mode: "companion",
	memoryShared: true,
	voiceVision: "auto",
	voiceFrames: 3,
	voiceFrameGapMs: 700
};
const MIN_INTERVAL_SEC = 15;
const MAX_INTERVAL_SEC = 3600;
/** 合法的模式集合（配置里写了别的就当 companion，不报错） */
const MODES = [
	"companion",
	"play",
	"watch"
];
function nextSightDelayMs(config, random = Math.random) {
	const lo = Math.min(config.jitterMin, config.jitterMax);
	const hi = Math.max(config.jitterMin, config.jitterMax);
	const factor = lo + random() * (hi - lo);
	const seconds = config.intervalSec * factor;
	return Math.max(5e3, Math.round(seconds * 1e3));
}
function normalizeSightConfig(raw) {
	const base = DEFAULT_SIGHT_CONFIG;
	const n = (v, fallback) => {
		const num$1 = Number(v);
		return Number.isFinite(num$1) ? num$1 : fallback;
	};
	const interval = Math.round(n(raw?.intervalSec, base.intervalSec));
	const mode = typeof raw?.mode === "string" && MODES.includes(raw.mode) ? raw.mode : base.mode;
	return {
		enabled: raw?.enabled === true,
		intervalSec: Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, interval)),
		keepSnapshots: Math.max(0, Math.min(200, Math.round(n(raw?.keepSnapshots, base.keepSnapshots)))),
		changeThreshold: Math.min(.9, Math.max(.001, n(raw?.changeThreshold, base.changeThreshold))),
		speak: raw?.speak === true,
		mode,
		memoryShared: raw?.memoryShared !== false,
		voiceVision: raw?.voiceVision === "off" || raw?.voiceVision === "always" || raw?.voiceVision === "auto" ? raw.voiceVision : base.voiceVision,
		voiceFrames: Math.max(1, Math.min(5, Math.round(n(raw?.voiceFrames, base.voiceFrames)))),
		voiceFrameGapMs: Math.max(200, Math.min(2e3, Math.round(n(raw?.voiceFrameGapMs, base.voiceFrameGapMs)))),
		jitterMin: Math.max(.2, Math.min(3, n(raw?.jitterMin, base.jitterMin))),
		jitterMax: Math.max(.2, Math.min(5, n(raw?.jitterMax, base.jitterMax))),
		...typeof raw?.windowTitle === "string" && raw.windowTitle.trim() !== "" ? { windowTitle: raw.windowTitle.trim() } : {}
	};
}
function isDuplicateReply(previous, current) {
	const clean = (s) => s.replace(/[\s，。！？、…~～,.!?]/g, "");
	const a = clean(previous);
	const b = clean(current);
	if (a === "" || b === "") return false;
	if (a === b) return true;
	const minLen = Math.min(a.length, b.length);
	let same = 0;
	for (let i = 0; i < minLen; i++) {
		if (a[i] !== b[i]) break;
		same++;
	}
	return same / minLen >= .6;
}
async function runSightRound(config, deps, state) {
	if (!config.enabled) return {
		kind: "skipped",
		reason: "disabled"
	};
	let shot;
	try {
		shot = await deps.capture();
	} catch (e) {
		return {
			kind: "failed",
			reason: "capture",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const bytes = Uint8Array.from(Buffer.from(shot.dataUrl.split(",")[1] ?? "", "base64"));
	const diff = deps.diff(state.lastJpeg, bytes);
	state.lastJpeg = bytes;
	if (diff < config.changeThreshold) return {
		kind: "skipped",
		reason: "unchanged"
	};
	if (config.keepSnapshots > 0) await deps.persist(shot.dataUrl.split(",")[1] ?? "", config.keepSnapshots);
	if (config.mode === "watch") return {
		kind: "skipped",
		reason: "watch-silent"
	};
	const result = await deps.describe(bytes, config.mode);
	if (!result.ok) return {
		kind: "failed",
		reason: result.reason,
		message: result.message
	};
	const reply = deps.parseReply(result.text);
	if (!reply.speak) return {
		kind: "skipped",
		reason: "no-reply"
	};
	if (isDuplicateReply(state.lastReply, reply.text)) return {
		kind: "skipped",
		reason: "duplicate"
	};
	state.lastReply = reply.text;
	return {
		kind: "spoke",
		text: reply.text,
		speak: config.speak,
		screenshot: shot
	};
}

//#endregion
//#region src/host/work-status.ts
/**
* turn/end reason.kind → 状态：
*   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting（回合被阻塞，等用户确认）；
*   其余（aborted 等）→ null＝该会话回合已结束，由调用方清理会话回空闲——绝不残留上一档
*   （否则回合被打断后会永远卡在 working，即当年"这一步正在进行中哦"挂死的根因）。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call": {
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		}
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
const TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current;
	for (const t of todos) if (t?.status === "in_progress") current = t;
	if (!current) current = todos.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : content;
}
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
var WorkStatusStore = class {
	constructor() {
		this.sessions = new Map();
		this.snap = {
			state: null,
			task: null,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案） */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清 → undefined） */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
	snapshot() {
		return this.snap;
	}
	/** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		if (nextState === this.snap.state && nextTask === this.snap.task) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.ts = Date.now();
	}
};

//#endregion
//#region src/host/notify-events.ts
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
function sessionIdOf(session) {
	const s = session;
	return String(s?.header?.id ?? s?.id ?? "unknown");
}
function isCompletionTurnEnd(event) {
	const e = event;
	return e?.type === "turn/end" && e.data?.reason?.kind === "completed";
}
function hasBlockingActivity(activity) {
	if (!Array.isArray(activity)) return false;
	for (const item of activity) {
		const kind = item?.kind;
		if (kind === "job" || kind === "subagent" || kind === "schedule") return true;
	}
	return false;
}
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户选择题答复） */
const USER_QUESTION_TOOL = "ask_user_question";
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const parsed = JSON.parse(args);
		const questions = parsed?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
function reduceNotifyFrame(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = turnEndNotifyKind(reason?.kind);
			if (!kind) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
function agentErrorFrame(error) {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		type: "host/agent-error",
		message
	};
}

//#endregion
//#region src/host/storage-paths.ts
const DESKTOP_APP_NAME = "dsh-whale-girl-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关） */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
*
* 与 Electron 的口径逐平台对齐：
*   win32  = %APPDATA%\<name>（appData 在 Windows 就是 Roaming）
*   darwin = ~/Library/Application Support/<name>
*   linux  = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
*
* env-paths 的口径：win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，
* Linux 用 $XDG_CACHE_HOME（默认 ~/.cache）——都是「应用名单独一层」。
* 该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
	const items = [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	];
	return items.map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
function profileNameFrom(packageRoot$1) {
	const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot$1);
	return m?.[1];
}

//#endregion
//#region src/host/state.ts
/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf(),
			autoplay: emptyLeaf()
		};
		this.pets = new Map();
	}
	/** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知）。
	* 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
	*/
	writeSection(name, data) {
		this.sections[name] = {
			counter: this.next(),
			data
		};
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，两个槽位一起建好，形状恒定） */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
};

//#endregion
//#region src/host/time-context.ts
/**
* 时段划分表：[起始小时, 时段]，**按起始小时从晚到早**排列——匹配时取第一个不超过当前小时的档。
* 口径（含起始小时，0–23 全覆盖、不重叠）：
*   凌晨 0–4 / 清晨 5–6 / 早上 7–8 / 上午 9–10 / 中午 11–12 / 下午 13–16 / 傍晚 17–18 / 晚上 19–22 / 深夜 23
*/
const SLOTS = [
	[23, "深夜"],
	[19, "晚上"],
	[17, "傍晚"],
	[13, "下午"],
	[11, "中午"],
	[9, "上午"],
	[7, "早上"],
	[5, "清晨"],
	[0, "凌晨"]
];
/** 星期文案：索引 = Date.getDay()（0 = 周日） */
const WEEKDAYS = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六"
];
/** 一天毫秒数（日期算术用 UTC 毫秒，避开本地时区） */
const DAY_MS = 864e5;
/** 缺省窗口：提前 3 天预热、本身 1 天、过后 3 天回味 */
const DEFAULT_AHEAD = 3;
const DEFAULT_SPAN = 1;
const DEFAULT_AFTER = 3;
/** 假期区间的窗口：提前 3 天预热、末尾 3 天说「快结束了」、结束后 3 天回味 */
const SEASON_AHEAD = 3;
const SEASON_ENDING_AHEAD = 3;
const SEASON_AFTER = 3;
/** 两位补零（只用于时分；月/日刻意不补零——中文日期写「2月17日」比「02月17日」自然） */
function pad2(n) {
	return String(n).padStart(2, "0");
}
function timeSlotOf(hour) {
	for (const [start, slot] of SLOTS) if (hour >= start) return slot;
	return "凌晨";
}
function dayKindOf(day) {
	return day === 0 || day === 6 ? "周末" : "工作日";
}
/**
* ★ 顺序 = 优先级（靠前的先说话）。编排口径：
*   ① 只有「当天」值得说、且会被邻座节日窗口挤掉的小节（情人节 / 跨年夜 / 愚人节 / 青年节）排在各自邻座之前，
*      并用 after: 0 掐掉回味，免得反过来压住邻座的当天；
*   ② 除夕、元宵必须排在春节之前：否则 2/16 会说「明天就是春节」、3/3 会说「春节假期最后一天」，
*      而不是「今天是除夕」「今天是元宵节」；
*   ③ 大节与家庭假期（春节 / 中秋 / 国庆 / 元旦 / 端午 / 清明 / 劳动节 / 寒暑假）在中段，
*      传统节日（七夕 / 中元 / 龙抬头 / 重阳 / 腊八 / 小年）紧随其后并**排在寒暑假之前**——
*      所以暑假里的七夕、寒假里的小年照常由节日说话；
*   ④ 纪念日类（妇女节 / 教师节 / 建党节 / 建军节 / 万圣夜 / 平安夜 / 圣诞节）排在最后，
*      因此暑假期间的建党节（7/1）、建军节（8/1）会让位给「正在放暑假」。
*   ⑤ 寒暑假区间放在中段之后、纪念日之前：7/1 既是建党节又是暑假首日，按本顺序由「暑假开始了」说话。
*/
const PRIORITY = [
	{
		kind: "solar",
		key: "2-14",
		name: "情人节",
		after: 0
	},
	{
		kind: "solar",
		key: "12-31",
		name: "跨年夜",
		after: 0
	},
	{
		kind: "solar",
		key: "4-1",
		name: "愚人节",
		after: 0
	},
	{
		kind: "solar",
		key: "5-4",
		name: "青年节",
		ahead: 0,
		after: 0
	},
	{
		kind: "lunarEve",
		name: "除夕",
		ahead: 1,
		after: 0
	},
	{
		kind: "lunar",
		key: "1-15",
		name: "元宵节"
	},
	{
		kind: "lunar",
		key: "1-1",
		name: "春节",
		spoken: "大年初一",
		span: 15
	},
	{
		kind: "lunar",
		key: "8-15",
		name: "中秋节",
		span: 3,
		after: 2
	},
	{
		kind: "solar",
		key: "10-1",
		name: "国庆节",
		span: 7
	},
	{
		kind: "solar",
		key: "1-1",
		name: "元旦",
		spoken: "新年第一天",
		span: 3
	},
	{
		kind: "lunar",
		key: "5-5",
		name: "端午节",
		span: 3
	},
	{
		kind: "solar",
		key: "4-4",
		name: "清明节",
		span: 3,
		ahead: 1
	},
	{
		kind: "solar",
		key: "5-1",
		name: "劳动节",
		span: 3
	},
	{
		kind: "solar",
		key: "6-1",
		name: "儿童节"
	},
	{
		kind: "lunar",
		key: "7-7",
		name: "七夕"
	},
	{
		kind: "lunar",
		key: "7-15",
		name: "中元节"
	},
	{
		kind: "lunar",
		key: "2-2",
		name: "龙抬头"
	},
	{
		kind: "lunar",
		key: "9-9",
		name: "重阳节"
	},
	{
		kind: "lunar",
		key: "12-8",
		name: "腊八节"
	},
	{
		kind: "lunar",
		key: "12-23",
		name: "小年"
	},
	{
		kind: "season",
		from: "1-20",
		to: "2-18",
		name: "寒假"
	},
	{
		kind: "season",
		from: "7-1",
		to: "8-29",
		name: "暑假"
	},
	{
		kind: "solar",
		key: "3-8",
		name: "妇女节"
	},
	{
		kind: "solar",
		key: "9-10",
		name: "教师节"
	},
	{
		kind: "solar",
		key: "7-1",
		name: "建党节"
	},
	{
		kind: "solar",
		key: "8-1",
		name: "建军节"
	},
	{
		kind: "solar",
		key: "10-31",
		name: "万圣夜"
	},
	{
		kind: "solar",
		key: "12-24",
		name: "平安夜",
		after: 0
	},
	{
		kind: "solar",
		key: "12-25",
		name: "圣诞节"
	}
];
/** 公历 / 农历 / 除夕 / 假期区间的索引（模块加载时按 PRIORITY 建一次） */
const SOLAR_INDEX = new Map();
const LUNAR_INDEX = new Map();
const SEASON_ENTRIES = [];
let LUNAR_EVE;
PRIORITY.forEach((entry, priority) => {
	if (entry.kind === "solar") SOLAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunar") LUNAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunarEve") LUNAR_EVE = {
		entry,
		priority
	};
	else SEASON_ENTRIES.push({
		entry,
		priority,
		from: entry.from,
		to: entry.to
	});
});
/** ICU 中国农历格式器；null = 已判定本环境不可用（不重试、不抛错） */
let lunarFormatter;
/**
* 取 ICU 农历格式器。
* Intl 在缺少该日历时**不会抛错**，而是静默退回公历——那会让每个月都被当成农历同月同日，
* 所以这里用 resolvedOptions().calendar 确认它真的解析成了 'chinese'，否则一律判不可用。
*/
function getLunarFormatter() {
	if (lunarFormatter === null) return void 0;
	if (!lunarFormatter) {
		const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", {
			month: "numeric",
			day: "numeric",
			year: "numeric"
		});
		lunarFormatter = fmt.resolvedOptions().calendar === "chinese" ? fmt : null;
	}
	return lunarFormatter ?? void 0;
}
/** 年内日序号（0 起，按 UTC 计算，闰年自然正确）——假期区间比较用它 */
function dayOfYear(date) {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS;
}
/** '月-日' → 该年内的日序号（0 起） */
function dayOfYearOf(year, monthDay) {
	const [month, day] = monthDay.split("-").map(Number);
	return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}
/**
* 公历日期 → 农历月日。
* @returns 农历月/日（闰月 month 为负）；环境不支持农历、取不到月日，或**农历年与公历年不吻合**
*   （自洽校验，合理范围：公历年或公历年 − 1，用于挡住 ICU 退化时把公历当农历返回）→ undefined。
*/
function lunarPartsOf(date) {
	const fmt = getLunarFormatter();
	if (!fmt) return void 0;
	const parts = fmt.formatToParts(date);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const rawMonth = pick("month");
	const rawDay = pick("day");
	const rawYear = pick("relatedYear") ?? pick("year");
	if (!rawMonth || !rawDay || !rawYear) return void 0;
	const month = Number.parseInt(rawMonth, 10);
	const day = Number.parseInt(rawDay, 10);
	const year = Number.parseInt(rawYear, 10);
	if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return void 0;
	const gregorianYear = date.getFullYear();
	if (year !== gregorianYear && year !== gregorianYear - 1) return void 0;
	return {
		month: /bis/i.test(rawMonth) ? -month : month,
		day
	};
}
/** 当天是否是除夕（腊月最后一天：次日为正月初一即成立，廿九/三十都能认） */
function isLunarEve(date) {
	const today = lunarPartsOf(date);
	if (!today || today.month !== 12) return false;
	const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
	return Boolean(next && next.month === 1 && next.day === 1);
}
/** 某一天命中的全部条目（公历、农历、除夕三类；假期区间不按天查，另行处理） */
function entriesAt(date) {
	const out = [];
	const solar = SOLAR_INDEX.get(date.getMonth() + 1 + "-" + date.getDate());
	if (solar) out.push(solar);
	const lunar = lunarPartsOf(date);
	if (lunar && lunar.month > 0) {
		const hit = LUNAR_INDEX.get(lunar.month + "-" + lunar.day);
		if (hit) out.push(hit);
	}
	if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
	return out;
}
/**
* 相位 → 从句措辞。
* @param delta 相对**节日起始日**的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后
*/
function phraseOf(entry, delta) {
	const span = entry.span ?? DEFAULT_SPAN;
	if (delta > 0) return delta === 1 ? "明天就是" + entry.name : "快要过" + entry.name + "了";
	if (delta === 0) return "今天是" + (entry.spoken ?? entry.name);
	const daysIn = -delta;
	if (daysIn < span) return span - daysIn === 1 ? entry.name + "假期最后一天了" : "还在" + entry.name + "假期里";
	const rest = daysIn - span;
	return rest <= 1 ? entry.name + "刚过完" : entry.name + "这么快就过完了";
}
/**
* 条目 → 候选从句（不在自身窗口内则返回 undefined）。
* @param delta 相对节日起始日的天数
*/
function candidateOf(ranked, delta) {
	const { entry, priority } = ranked;
	const ahead = entry.ahead ?? DEFAULT_AHEAD;
	const span = entry.span ?? DEFAULT_SPAN;
	const after = entry.after ?? DEFAULT_AFTER;
	const daysIn = -delta;
	if (delta > 0) {
		if (delta > ahead) return void 0;
	} else if (delta < 0) {
		if (daysIn >= span + after) return void 0;
	}
	return {
		clause: phraseOf(entry, delta),
		priority
	};
}
/** 假期区间 → 候选从句（不在窗口内返回 undefined） */
function seasonCandidateOf(date) {
	const year = date.getFullYear();
	const today = dayOfYear(date);
	for (const ranked of SEASON_ENTRIES) {
		const { entry, priority, from: fromMd, to: toMd } = ranked;
		const name = entry.name;
		const from = dayOfYearOf(year, fromMd);
		const to = dayOfYearOf(year, toMd);
		if (today < from) {
			const ahead = from - today;
			if (ahead > SEASON_AHEAD) continue;
			return {
				clause: ahead === 1 ? "明天就放" + name + "了" : "快要放" + name + "了",
				priority
			};
		}
		if (today <= to) {
			if (today === from) return {
				clause: name + "开始了",
				priority
			};
			if (to - today < SEASON_ENDING_AHEAD) return {
				clause: name + "快结束了",
				priority
			};
			return {
				clause: "正在放" + name,
				priority
			};
		}
		const rest = today - to - 1;
		if (rest >= SEASON_AFTER) continue;
		return {
			clause: rest <= 1 ? name + "刚结束" : name + "这么快就过完了",
			priority
		};
	}
	return void 0;
}
/** 条目里最长的预热天数与回看距离（长假 15 天 + 回味 3 天），据此决定扫描窗口 */
const HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== "season");
const MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
const MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));
/**
* 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取**优先级最小**（数组里最靠前）的那个。
* @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''
*/
function holidayClauseOf(date) {
	let best;
	const keep = (candidate) => {
		if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
	};
	for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
		for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
	}
	keep(seasonCandidateOf(date));
	return best ? best.clause : "";
}
function timeContextOf(date) {
	if (Number.isNaN(date.getTime())) return "";
	const day = date.getDay();
	const hour = date.getHours();
	const holiday = holidayClauseOf(date);
	return "【当下】现在是" + date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日" + (WEEKDAYS[day] ?? "星期?") + " " + pad2(hour) + ":" + pad2(date.getMinutes()) + "，" + timeSlotOf(hour) + "，" + dayKindOf(day) + (holiday ? "，" + holiday : "") + "。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。";
}

//#endregion
//#region src/host/index.ts
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, "assets");
/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, "memes");
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-whale-girl";
/**

* 宿主是不是 **DSH 桌面应用**（Electron 宿主）。

*

* 判据只用 `process.versions.electron`：桌面应用以 `ELECTRON_RUN_AS_NODE=1` 跑宿主（见 dsh.cmd），

* 该字段照样在；而 `dsh web` / 独立模式都是纯 Node 进程，取不到它。据此把「打开网站」自动分派：

* 桌面宿主 → 唤起桌面应用窗口（helper 走 `dsh://open`），其余 → 浏览器打开站点。

*/
const isDesktopHost = () => Boolean(process.versions.electron);
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**

* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。

* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined

*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/**

* 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。

*

* Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往

* $DSH_HOME/dsh-whale-girl/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/

* 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、

* 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的

* fstat 拿到的大小与随后读出的字节天然一致。

*/
function sendFile(res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		try {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": fstatSync(fd).size,
				"cache-control": "public, max-age=3600"
			});
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
		}
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible$1 = (display) => display === "desktop" || display === "both";
/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson$1(res, status, obj$1, headers = {}) {
	const body = JSON.stringify(obj$1);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText$1(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
/**

* 发送二进制响应（语音合成的 MP3）。

*

* 只走 HTTP：桌面 Helper 的 bridge 管道是 JSON 行协议，塞不了二进制音频。

* 桌面窗里的语音走 `/voice/tts` 的 HTTP 端点（与本机 127.0.0.1 同源），不经 bridge。

*/
function sendBuffer(res, status, body, contentType) {
	const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	res.writeHead(status, {
		"content-type": contentType,
		"content-length": buf.length,
		"cache-control": "no-store"
	});
	res.end(buf);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function apply(ctx) {
	const dshHome = dshHomeDir();
	const userRoot = join(dshHome, "dsh-whale-girl");
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => console.log("[dsh-whale-girl] " + msg));
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	const sightConfigPath = join(userRoot, "sight.json");
	const sightSnapshotsRoot = join(userRoot, SIGHT_DIR);
	const readSightConfig = () => {
		try {
			const raw = JSON.parse(readFileSync(sightConfigPath, "utf8"));
			return normalizeSightConfig(raw);
		} catch {
			return { ...DEFAULT_SIGHT_CONFIG };
		}
	};
	/** 跨轮次的识屏状态：上一帧（判帧差）、上一句话（去重）与最近几句（防模板化重复） */
	const sightState = {
		lastReply: "",
		recent: []
	};
	const autoplayConfigPath = join(userRoot, "autoplay.json");
	const readAutoplayConfig = () => {
		try {
			return normalizeAutoplayConfig(JSON.parse(readFileSync(autoplayConfigPath, "utf8")));
		} catch {
			return { ...DEFAULT_AUTOPLAY_CONFIG };
		}
	};
	/**
	
	* 代打用的急停控制器。
	
	*
	
	* 生命周期跟着插件：配置变更时重建（换了热键就要换监听），
	
	* 卸载时停掉监听进程（否则会留下一个孤儿 PowerShell 一直轮询）。
	
	*/
	let autoplayEstop = createEstop(readAutoplayConfig().estopKey);
	let stopEstopWatcher;
	/** 重建急停控制器与监听（配置变更后调用） */
	const rearmAutoplay = async (config) => {
		stopEstopWatcher?.();
		stopEstopWatcher = void 0;
		autoplayEstop = createEstop(config.estopKey, (reason) => {
			console.warn(`[dsh-whale-girl] 代打急停：${reason}`);
		});
		if (config.enabled) {
			const voiceShortcut = readVoiceConfig().shortcut ?? DEFAULT_VOICE_SHORTCUT;
			const parsedVoice = parseHotkey(voiceShortcut);
			stopEstopWatcher = autoplayEstop.startWatching({ ...parsedVoice.ok ? { voiceSpec: parsedVoice.spec } : {} });
		}
	};
	/**
	
	* 跑一轮代打。
	
	*
	
	* 所有副作用都从这一处注入，方便日后单测；决策逻辑本身在 autoplay.ts（纯函数）。
	
	*/
	/**
	
	* 解析「识图该用哪个模型」。
	
	*
	
	* 顺序：单独指定 → **该宠物配置的 chatModel** → 会话实际模型。
	
	*
	
	* 为什么中间那环必须读宠物配置：主人是在「AI 与语音」页里选对话模型的，
	
	* 那个值存在 `main-config.jsonc` 的 `chatModel`，**不在 sight.json 里**。
	
	* 早先这里读的是 sight.json（那里根本没有 chatModel），于是一路落到「会话实际模型」，
	
	* 表现就是「我明明切了模型，看屏幕还显示旧的」。
	
	*/
	const resolveVisionModel = (override) => {
		if (override !== void 0) return override;
		try {
			const cfg = readAllConfig(configPaths);
			const petId = resolveActivePetId();
			const found = findPetInstance(cfg, petId);
			const conf = found ? found.conf : cfg.main ?? {};
			const configured = configuredModel(conf, "chatModel");
			if (configured !== void 0) return configured;
		} catch {}
		return resolveCurrentModel();
	};
	/**
	
	* 安全取 attachments 服务。
	
	*
	
	* 它**不在本插件的 inject 列表**里，直接写 `ctx.attachments` 会被 cordis 抛
	
	* 「cannot get property "attachments" without inject」（实测 500 就是这个）。
	
	* 用软取：没有就返回 undefined，调用方按「附件不可用」处理，
	
	* 而不是让整个路由崩掉。
	
	*/
	const getAttachments = () => {
		try {
			return ctx.get("attachments", false);
		} catch {
			return void 0;
		}
	};
	/**
	
	* 代打用的技能库 + 上一帧/上一句描述。
	
	*
	
	* 技能只在「画面几乎没变」时复用：画面一变，之前那句描述就不再对应现在的屏幕，
	
	* 硬套技能会让她在错误场景按错键。
	
	*/
	const appsPath = join(userRoot, "apps.json");
	/** 读用户自定义别名（与内置表合并；用户条目优先） */
	const readAppAliases = () => {
		let user = {};
		try {
			const raw = JSON.parse(readFileSync(appsPath, "utf8"));
			if (raw !== null && typeof raw === "object") {
				for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && k.trim() !== "" && v.trim() !== "") user[k] = v;
			}
		} catch {}
		return {
			...DEFAULT_APP_ALIASES,
			...user
		};
	};
	const gamesRoot = join(userRoot, "games");
	/** 本局游戏会话（玩的时候往里灌，退出时压缩成一条摘要写回共用记忆） */
	let autoplaySession;
	/** 本局用的游戏档案（跑的时候用于拼提示词） */
	let currentGame;
	/** 待确认的发送任务（确认后才按键） */
	let pendingMessage;
	/** 连续卡住几轮（noop / 解析失败 / 被拒），到阈值就自己上网查攻略 */
	let autoplayStuck = 0;
	/** 上次自动查攻略的时间（冷却用） */
	let autoplayLastSearchAt;
	const readGames = async () => {
		try {
			const names = (await readdir(gamesRoot)).filter((n) => n.endsWith(".json"));
			const out = [];
			for (const name of names) try {
				const parsed = normalizeProfile(JSON.parse(readFileSync(join(gamesRoot, name), "utf8")));
				out.push(parsed);
			} catch {}
			return out.sort((a, b) => a.title.localeCompare(b.title));
		} catch {
			return [];
		}
	};
	const writeGame = async (profile) => {
		await mkdir(gamesRoot, { recursive: true });
		await writeFile(join(gamesRoot, profile.id + ".json"), JSON.stringify(profile, null, 2) + "\n", "utf8");
	};
	/**
	
	* 结束本局：把会话压缩成一条摘要写进**共用记忆**，然后清空缓冲。
	
	*
	
	* 主人要求「记忆共用一份，只是玩的时候容量放大」——所以这里不是存到另一个地方，
	
	* 而是压成一条 assistant 注记塞回 memory.json，长期记忆仍是一条线。
	
	*/
	const endAutoplaySession = async () => {
		const session = autoplaySession;
		if (session === void 0 || !shouldCompress(session)) {
			autoplaySession = void 0;
			return void 0;
		}
		const petId = resolveActivePetId();
		let target = 5;
		try {
			const cfg = readAllConfig(configPaths);
			target = memoryRounds(petId, cfg);
		} catch {}
		const summary = compressSession(session, target);
		try {
			const mem = await readMemory();
			const cfg = readAllConfig(configPaths);
			const found = findPetInstance(cfg, petId);
			const entryKey = found ? found.entry : "main";
			const bucket = mem[entryKey] ??= {};
			const record = bucket[petId] ??= { messages: [] };
			record.messages.push({
				role: "assistant",
				content: summary,
				ts: Date.now()
			});
			const keep = Math.max(0, target) * 2;
			if (keep > 0 && record.messages.length > keep) record.messages = record.messages.slice(-keep);
			await writeMemory(mem);
		} catch (e) {
			console.warn("[dsh-whale-girl] 结束本局写记忆失败：" + (e instanceof Error ? e.message : String(e)));
		}
		const steps = session.steps.length;
		autoplaySession = void 0;
		return {
			steps,
			summary
		};
	};
	const autoplaySkills = [];
	let autoplayLastJpeg;
	let autoplayLastDesc = "";
	/**
	
	* 防「同一个动作无限重放」：
	
	* - 技能快路径最多连用 1 次，之后必须重新看图（否则一次没生效的点击会被永远重放）；
	
	* - 连续 3 次相同动作且画面没变 → 停手报原因（这是主人实测「一直点同一个点」的根因）。
	
	*/
	let autoplaySkillReuses = 0;
	let lastActionKey = "";
	let sameActionRounds = 0;
	/** 连续「画面几乎没有变化」的轮数（动作不同也算：卡在菜单上就是这种形态） */
	let noProgressRounds = 0;
	/** 本轮截图与上一轮的差异（0~1）；1 = 首轮/完全不同 */
	let lastCaptureDiff = 1;
	/**
	
	* 主人在陪玩过程中用语音给的战术提醒（全局热键 → ASR 识别出来的那句话）。
	
	* 下一轮会作为「主人刚刚提醒」写进给模型的上下文，用掉即清。
	
	*/
	let autoplayUserHint = "";
	/**
	
	* 代打默认挑一个「快」的识图模型。
	
	*
	
	* 为什么不直接跟随对话模型：实测（2026-10-18，同一张游戏截图）
	
	*   workbuddy/step-5-preview（对话模型）   100 秒都没出结果，还空回复
	
	*   deepseek-account/deepseek-flash       **1.9 秒**
	
	*   workbuddy-ai/deepseek-v4.1-flash       4.6 秒
	
	* 对话模型偏重思考，代打要的是「快 + 能看图 + 按格式吐一行」，所以默认先用前者。
	
	* 两个都用不了才回落到对话模型（行为与旧版一致）。
	
	*/
	const pickFastVisionModel = () => {
		try {
			const llm = ctx.llm;
			const ids = (llm?.listProviders?.() ?? []).map((p) => String(p.id ?? ""));
			if (ids.includes("deepseek-account")) return {
				provider: "deepseek-account",
				model: "deepseek-flash"
			};
			if (ids.includes("workbuddy-ai")) return {
				provider: "workbuddy-ai",
				model: "deepseek-v4.1-flash"
			};
		} catch {}
		return void 0;
	};
	const runAutoplayOnce = async (config) => {
		const visionModel = config.visionModel ?? pickFastVisionModel() ?? resolveVisionModel();
		if (autoplaySession === void 0) {
			const games = await readGames();
			const matched = config.windowTitles.length > 0 ? games.find((g) => windowMatchesAllowed(g.title, config.windowTitles)) : games[0];
			const game = matched ?? normalizeProfile({ title: config.windowTitles[0] ?? "未指定游戏" });
			const cap = game.memoryCap ?? GENRE_MEMORY_CAP[game.genre] ?? GENRE_MEMORY_CAP.custom;
			autoplaySession = createGameSession(game.title, cap);
			currentGame = game;
		}
		const roundStartedAt = Date.now();
		const coachHint = autoplayUserHint;
		const stuckHint = [
			sameActionRounds >= 1 ? "注意：你刚才连续执行同一个动作、但画面没有变化。" : "",
			noProgressRounds >= 2 ? `注意：画面已经连续 ${noProgressRounds + 1} 轮几乎没有变化。如果画面里有菜单（结束回合/概览/任务/取消），先点「取消」；否则换一个完全不同的操作。` : "",
			sameActionRounds >= 1 || noProgressRounds >= 2 ? "战棋移动单位要 drag（拖动）不是 click。" : ""
		].filter((part) => part !== "").join(" ");
		const round = await runAutoplayRound({
			capture: async () => {
				const shot = await captureScreen();
				const b64 = shot.dataUrl.split(",")[1] ?? "";
				const jpeg = Uint8Array.from(Buffer.from(b64, "base64"));
				lastCaptureDiff = autoplayLastJpeg === void 0 ? 1 : frameDiff(autoplayLastJpeg, jpeg);
				autoplayLastJpeg = jpeg;
				try {
					await saveSnapshot(sightSnapshotsRoot, b64, readSightConfig().keepSnapshots);
				} catch {}
				return {
					jpeg,
					width: shot.width,
					height: shot.height
				};
			},
			describe: async (jpeg, context, screen) => {
				if (visionModel === void 0) return {
					ok: false,
					message: "没有可用的模型"
				};
				if (coachHint !== "") autoplayUserHint = "";
				autoplaySkillReuses = 0;
				const attachments = getAttachments();
				if (attachments === void 0) return {
					ok: false,
					message: "附件服务不可用（无法把图片交给模型）"
				};
				const hint = [
					context.trim() === "" ? "" : "游戏档案与最近战况：\n" + context,
					"画面尺寸：" + screen.width + "×" + screen.height + "（click 的 X/Y 按这个尺寸）",
					"现在只输出下一步动作，一行。"
				].filter((part) => part !== "").join("\n\n");
				const result = await lookAtScreen({
					llm: ctx.llm,
					attachments
				}, jpeg, visionModel, "action", hint, (refs) => {
					purgeAttachmentObjects(ctx, refs);
				}, AUTOPLAY_PROMPT);
				return result.ok ? {
					ok: true,
					text: result.text
				} : {
					ok: false,
					message: result.message
				};
			},
			perform: async (action) => {
				const result = await performInput(action, {
					allowedTitles: config.windowTitles,
					matchesTitle: windowMatchesAllowed
				});
				return result.ok ? { ok: true } : {
					ok: false,
					message: result.message
				};
			},
			foregroundTitle: () => foregroundWindowTitle(),
			log: (message) => console.log("[dsh-whale-girl] " + message),
			trySkill: () => {
				if (autoplaySkills.length === 0 || autoplayLastDesc === "") return void 0;
				if (autoplaySkillReuses >= 1) return void 0;
				if (lastCaptureDiff >= .01) return void 0;
				const hit = matchSkill(autoplaySkills, autoplayLastDesc);
				if (hit === void 0) return void 0;
				autoplaySkillReuses++;
				return {
					name: hit.name,
					actions: hit.actions
				};
			},
			learnSkill: (description, actions, ok) => {
				autoplayLastDesc = description;
				const existing = autoplaySkills.find((s) => s.name === description && s.actions.length === actions.length);
				if (existing !== void 0) {
					scoreSkill(existing, ok);
					const kept$1 = pruneSkills(autoplaySkills);
					autoplaySkills.length = 0;
					autoplaySkills.push(...kept$1);
					return;
				}
				if (!ok) return;
				const created = createSkill(description, actions, autoplaySkills);
				if (created !== void 0) autoplaySkills.push(created);
				const kept = pruneSkills(autoplaySkills);
				autoplaySkills.length = 0;
				autoplaySkills.push(...kept);
			}
		}, {
			dryRun: config.dryRun,
			allowedTitles: config.windowTitles,
			gameContext: [
				profileBrief(currentGame ?? normalizeProfile({ title: "未指定游戏" })),
				recentContext(autoplaySession ?? createGameSession("", 1), 12),
				stuckHint,
				coachHint === "" ? "" : "主人刚刚用语音提醒：" + coachHint
			].filter((x) => x !== "").join("\n")
		}, autoplayEstop);
		appendFile(join(userRoot, "voice-trace.log"), JSON.stringify({
			at: new Date().toISOString(),
			step: "autoplay.round",
			detail: {
				elapsedMs: Date.now() - roundStartedAt,
				kind: round.kind,
				reason: round.kind === "skipped" || round.kind === "stopped" ? round.reason : void 0,
				model: visionModel === void 0 ? void 0 : visionModel.provider + "/" + visionModel.model,
				thought: round.kind === "planned" ? round.thought.slice(0, 100) : void 0,
				actions: round.kind === "planned" ? JSON.stringify(round.actions).slice(0, 200) : void 0
			}
		}) + "\n", "utf8").catch(() => {});
		if (round.kind === "planned") {
			const actionKey = JSON.stringify(round.actions);
			if (actionKey === lastActionKey && lastCaptureDiff < .02) sameActionRounds++;
			else {
				sameActionRounds = 0;
				lastActionKey = actionKey;
			}
			if (lastCaptureDiff < .01) noProgressRounds++;
			else noProgressRounds = 0;
			if (sameActionRounds >= 2) return {
				kind: "stopped",
				reason: "连续 3 次同一个动作、画面没有变化（大概是点空了）"
			};
			if (noProgressRounds >= 6) return {
				kind: "stopped",
				reason: "连续 6 轮画面几乎没有变化（可能卡在菜单或动作无效）"
			};
		} else {
			sameActionRounds = 0;
			lastActionKey = "";
		}
		if (autoplaySession !== void 0) {
			if (round.kind === "planned") recordStep(autoplaySession, {
				at: Date.now(),
				screen: round.thought,
				plan: round.thought,
				executed: round.executed,
				outcome: round.executed ? "ok" : config.dryRun ? "dry" : "rejected"
			});
			else if (round.kind === "stopped") recordStep(autoplaySession, {
				at: Date.now(),
				screen: "急停",
				plan: "停止操作",
				executed: false,
				outcome: "stopped"
			});
		}
		if (round.kind === "planned" && round.executed) autoplayStuck = 0;
		else if (round.kind === "skipped" && (round.reason === "model-noop" || round.reason === "unparseable") || round.kind === "failed" && round.reason === "inject") autoplayStuck++;
		if (currentGame !== void 0 && shouldSearchGuide({
			stuckRounds: autoplayStuck,
			hasGuide: currentGame.guide !== void 0,
			...autoplayLastSearchAt === void 0 ? {} : { lastSearchAt: autoplayLastSearchAt }
		})) {
			autoplayStuck = 0;
			autoplayLastSearchAt = Date.now();
			console.log("[dsh-whale-girl] 连续卡住，自己查攻略：" + currentGame.title);
			const web = ctx.get("web", false);
			const found = await searchGuide(web, currentGame.title);
			if (found.ok) {
				currentGame = normalizeProfile({
					...currentGame,
					guide: {
						query: found.query,
						summary: found.summary,
						sources: found.sources,
						atMs: found.atMs
					}
				});
				await writeGame(currentGame);
			}
		}
		return round;
	};
	/**
	
	* 陪玩循环：把「一轮」串成「一直玩」。
	
	*
	
	* runRound 复用 runAutoplayOnce（同一套急停/窗口/截图/模型/注入安全闸），
	
	* 这里只负责节奏与停止口径（见 src/host/play-loop.ts 的模块注释）。
	
	*/
	let playWasRunning = false;
	/** 头顶气泡的上一句：同一句不重复写（窗口不在白名单时每秒都会触发） */
	let lastPlayBubble = "";
	const pushPlayBubble = (text) => {
		const trimmed = text.trim();
		if (trimmed === "" || trimmed === lastPlayBubble) return;
		lastPlayBubble = trimmed;
		try {
			const petId = resolveActivePetId() || "main";
			state.writePet(petId, "say", { text: trimmed });
		} catch {}
	};
	/**
	
	* 把循环内部消息翻译成给人看的气泡。
	
	*
	
	* 为什么不直接显示 lastMessage：窗口不在白名单时它是
	
	* 「不在白名单窗口：@docs\HANDOFF… — DeepSeek Harness」这种长串，
	
	* 主人只会觉得在刷屏。这里换成「等游戏窗口（现在前台：DSH）」。
	
	*/
	const playBubbleText = (message) => {
		const prefix = "不在白名单窗口：";
		if (!message.startsWith(prefix)) return message;
		const current = message.slice(prefix.length).trim();
		const short = current.length > 26 ? current.slice(0, 26) + "…" : current;
		return "等我切到游戏窗口…（现在前台：" + (short === "" ? "无标题" : short) + "）";
	};
	/** 思考气泡延迟 800ms 再写：窗口不对的轮次一两百毫秒就返回，不该闪一下「思考中」 */
	let thinkingBubbleTimer = null;
	const clearThinkingBubble = () => {
		if (thinkingBubbleTimer !== null) {
			clearTimeout(thinkingBubbleTimer);
			thinkingBubbleTimer = null;
		}
	};
	const playLoop = createPlayLoop({
		runRound: async () => {
			const conf = readAutoplayConfig();
			if (!conf.enabled) return {
				kind: "stopped",
				reason: "disabled"
			};
			return runAutoplayOnce(conf);
		},
		intervalMs: 1200,
		failureDelayMs: 3e3,
		failureLimit: 3,
		maxRounds: 200,
		onState: (snap) => {
			if (snap.running && snap.lastMessage.startsWith("不在白名单窗口")) autoplayEstop.grantGrace(3e3);
			if (snap.running) if (snap.state === "thinking") {
				if (thinkingBubbleTimer === null) thinkingBubbleTimer = setTimeout(() => {
					thinkingBubbleTimer = null;
					pushPlayBubble(readAutoplayConfig().dryRun ? "让我想想…（空跑：只看不动）" : "让我想想…");
				}, 800);
			} else {
				clearThinkingBubble();
				if (snap.lastMessage !== "") pushPlayBubble(playBubbleText(snap.lastMessage));
			}
			else if (playWasRunning) {
				clearThinkingBubble();
				pushPlayBubble(playBubbleText(snap.lastMessage));
			}
			if (playWasRunning && !snap.running) endAutoplaySession().catch(() => {});
			if (snap.running !== playWasRunning) try {
				state.writeSection("autoplay", {
					running: snap.running,
					state: snap.state
				});
			} catch {}
			playWasRunning = snap.running;
		}
	});
	/**
	
	* 开始陪玩（设置页按钮、右键菜单、语音指令共用这一条路径）。
	
	* @returns ok=false 时带明确原因（真注入没白名单会被拒）
	
	*/
	const beginPlay = async (patch = {}) => {
		const current = readAutoplayConfig();
		const requestedVision = patch.visionModel === null ? void 0 : patch.visionModel !== void 0 ? patch.visionModel : current.visionModel;
		const next = normalizeAutoplayConfig({
			enabled: true,
			dryRun: typeof patch.dryRun === "boolean" ? patch.dryRun : current.dryRun,
			estopKey: typeof patch.estopKey === "string" ? patch.estopKey : current.estopKey,
			windowTitles: Array.isArray(patch.windowTitles) ? patch.windowTitles.filter((v) => typeof v === "string" && v.trim() !== "") : current.windowTitles,
			visionModel: requestedVision
		});
		if (!next.dryRun && next.windowTitles.length === 0) return {
			ok: false,
			message: "真注入模式必须填「允许动手的窗口」白名单（否则可能点错到别的窗口）"
		};
		await mkdir(userRoot, { recursive: true });
		await writeFile(autoplayConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
		await rearmAutoplay(next);
		autoplayEstop.resume();
		autoplayEstop.grantGrace(5e3);
		try {
			const subprocess = ctx.get("subprocess", false);
			const wins = await listWindows(subprocess);
			const target = wins.find((w) => windowMatchesAllowed(w.title, next.windowTitles));
			if (target !== void 0) {
				const focused = await focusWindow(subprocess, target.pid);
				pushPlayBubble(focused ? "切到「" + target.title + "」，开始了…" : "想切到「" + target.title + "」但系统没让，点一下游戏窗口就行");
			} else if (next.windowTitles.length > 0) pushPlayBubble("没找到白名单里的窗口：" + next.windowTitles.join(" / "));
		} catch {}
		playLoop.start();
		return { ok: true };
	};
	/** 停止陪玩：停循环 + 急停 + 结束本局（压缩记忆）。三处入口共用，避免行为漂移 */
	const stopPlayNow = async (reason) => {
		playLoop.stop(reason);
		autoplayEstop.stop("manual");
		return endAutoplaySession();
	};
	/**
	
	* 跑一轮识屏：看屏幕 → 判断值不值得说 → 写进 `say` 叶子（气泡 / 可选语音）。
	
	*
	
	* 这是**唯一**的落地出口：手动触发（POST /sight/run）和定时器都走它，
	
	* 保证两条路径行为完全一致，不会出现「手动能说、定时不说」这种漂移。
	
	*/
	/**
	
	* 删掉刚才为了送图而临时写下的附件对象（「落地即焚」）。
	
	*
	
	* 为什么要这么做：DSH 的图片消息只能吃 `ImageAttachmentRef`，而附件存储
	
	* **只有落盘实现**（`writeFile` + `link` 到 `objects/<sha256>`，全文没有内存模式）。
	
	* 主人接受「落盘约 1 秒」，但要求**调用完就删**。
	
	*
	
	* 注意：路径是内容寻址的（`objects/<sha256 前2位>/<sha256>`），删之前先确认
	
	* 它确实是我们这次写的那份；删除失败只记日志，绝不影响对话结果。
	
	*/
	const purgeAttachmentObjects = async (context, refs) => {
		if (refs.length === 0) return;
		try {
			const attachments = context.attachments;
			const root = attachments?.root ?? join(dshHome, "attachments", "v1", "objects");
			for (const ref of refs) {
				const id = typeof ref.attachmentId === "string" ? ref.attachmentId : "";
				if (id === "") continue;
				const file = join(root, id.slice(0, 2), id);
				try {
					await unlink(file);
				} catch {}
			}
		} catch {}
	};
	/**
	
	* 执行一条语音指令。
	
	*
	
	* 返回要播报的话；返回 undefined = 这个意图当前不可用（交给正常对话兜底）。
	
	*
	
	* 注意：这里**不绕过任何安全闸**——开关走的是和设置页同一个配置写盘，
	
	* 代打仍然受急停与窗口白名单约束，语音只是"另一只手按同一个按钮"。
	
	*/
	const runVoiceIntent = async (intent, petId) => {
		if (intent === void 0) return void 0;
		try {
			switch (intent.kind) {
				case "stop-now": {
					autoplayEstop.stop("manual");
					return intentReply(intent);
				}
				case "end-session": {
					const ended = await endAutoplaySession();
					if (ended === void 0) return "这局还没开始呢。";
					return ended.summary;
				}
				case "toggle-sight": {
					const current = readSightConfig();
					const next = {
						...current,
						enabled: intent.on ?? !current.enabled
					};
					await mkdir(userRoot, { recursive: true });
					await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
					armSightTimer();
					return intentReply({
						...intent,
						on: next.enabled
					});
				}
				case "toggle-autoplay": {
					const running = playLoop.snapshot().running;
					const wantOn = intent.on ?? !running;
					if (wantOn) {
						const started = await beginPlay();
						if (!started.ok) return started.message;
						return "好，我开始陪玩啦。累了就说「停」或者按急停键。";
					}
					await stopPlayNow("voice");
					return "好，先停在这。";
				}
				case "look-now": return void 0;
				case "status": {
					const sightOn = readSightConfig().enabled;
					const autoOn = readAutoplayConfig().enabled;
					const steps = autoplaySession?.steps.length ?? 0;
					return `识屏${sightOn ? "开着" : "关着"}，代打${autoOn ? "开着" : "关着"}，本局记了 ${steps} 步。`;
				}
				case "open-app": {
					const sub = ctx.get("subprocess", false);
					const wins = await listWindows(sub);
					const hit = findWindow(wins, intent.target);
					if (hit !== void 0) {
						const focused = await focusWindow(sub, hit.pid);
						return focused ? `切到「${hit.title}」了。` : `「${hit.title}」开着，但没切过去（系统不肯让）。`;
					}
					const opened = await openApp(sub, intent.target, readAppAliases());
					return opened.ok ? intentReply(intent) : `没打开${intent.target}：${opened.message}`;
				}
				case "search": {
					const web = ctx.get("web", false);
					const result = await searchGuide(web, intent.query, "");
					if (!result.ok) return `没查到：${result.message}`;
					return `查到一些：「${result.summary.slice(0, 120)}」`;
				}
			}
		} catch (e) {
			console.warn("[dsh-whale-girl] 语音指令执行失败：" + (e instanceof Error ? e.message : String(e)));
			return "这条命令没执行成功。";
		}
	};
	/**
	
	* 执行一个「自己能做」的动作。
	
	*
	
	* 返回要播报的话；undefined = 这个动作当前做不了（交给正常对话兜底）。
	
	* 所有失败都如实说——"好的我去做了"然后什么都没发生是最坏的结果。
	
	*/
	const runSelfAction = async (action) => {
		const sub = ctx.get("subprocess", false);
		switch (action.do) {
			case "open-app": {
				const wins = await listWindows(sub);
				const hit = findWindow(wins, action.target);
				if (hit !== void 0) {
					const focused = await focusWindow(sub, hit.pid);
					return focused ? `切到「${hit.title}」了。` : `「${hit.title}」开着，但没切过去。`;
				}
				const opened = await openApp(sub, action.target, readAppAliases());
				return opened.ok ? `好，打开${action.target}。` : `没打开${action.target}：${opened.message}`;
			}
			case "focus-window": {
				const wins = await listWindows(sub);
				const hit = findWindow(wins, action.target);
				if (hit === void 0) return `没找到「${action.target}」这个窗口。`;
				const focused = await focusWindow(sub, hit.pid);
				return focused ? `切到「${hit.title}」了。` : `「${hit.title}」没切过去。`;
			}
			case "open-url": {
				const r = await runCommand(sub, [
					"powershell.exe",
					"-NoProfile",
					"-Command",
					`Start-Process '${action.url.replace(/'/g, "''")}'`
				], { timeoutMs: 2e4 });
				return r.ok ? `好，打开 ${action.url}。` : `打不开网址：${r.message}`;
			}
			case "search-web": {
				const url = "https://www.bing.com/search?q=" + encodeURIComponent(action.query);
				const r = await runCommand(sub, [
					"powershell.exe",
					"-NoProfile",
					"-Command",
					`Start-Process '${url}'`
				], { timeoutMs: 2e4 });
				return r.ok ? `好，帮你搜「${action.query}」。` : `搜不了：${r.message}`;
			}
			case "play-music": {
				const wins = await listWindows(sub);
				const netease = findWindow(wins, "网易云") ?? findWindow(wins, "cloudmusic");
				if (netease !== void 0) {
					const focused = await focusWindow(sub, netease.pid);
					return focused ? `网易云开着，你去搜「${action.what}」吧。` : `网易云没切过去。`;
				}
				const opened = await openApp(sub, "cloudmusic", readAppAliases());
				if (!opened.ok) return `打不开网易云：${opened.message}`;
				const run$1 = await runTask(`在网易云音乐里播放「${action.what}」`, {
					allowedTitles: ["网易云音乐", "cloudmusic"],
					maxSteps: 15,
					dryRun: false
				});
				return run$1.ok ? `放上了：${run$1.summary}` : `打开了网易云，但没能自动播放（${run$1.summary}）`;
			}
			case "send-message": {
				pendingMessage = {
					app: action.app,
					to: action.to,
					text: action.text,
					at: Date.now()
				};
				return describePending(pendingMessage);
			}
		}
	};
	/**
	
	* 执行「确认过了」的发送：真正按键。
	
	*
	
	* 每一步失败就停手（不再往下按），因为后半段的按键会落到错误的窗口里，
	
	* 那比不发更糟。中文只能走剪贴板——SendKeys 打不出中文。
	
	*/
	const executePendingMessage = async () => {
		const pending = pendingMessage;
		if (pending === void 0) return "没有待发的消息。";
		if (isExpired(pending)) {
			pendingMessage = void 0;
			return "这条消息放太久了，已经作废。要发的话再跟我说一次。";
		}
		pendingMessage = void 0;
		const sub = ctx.get("subprocess", false);
		const wins = await listWindows(sub);
		const win = findWindow(wins, pending.app);
		if (win === void 0) {
			const opened = await openApp(sub, pending.app, readAppAliases());
			if (!opened.ok) return `打不开${pending.app}：${opened.message}`;
			await new Promise((r) => setTimeout(r, 2500));
		} else {
			const focused = await focusWindow(sub, win.pid);
			if (!focused) return `没法把${pending.app}切到前台，所以没发。`;
		}
		for (const step of planSend(pending)) {
			if (step.kind === "clipboard") {
				const r = await runCommand(sub, [
					"powershell.exe",
					"-NoProfile",
					"-Command",
					`Set-Clipboard -Value '${step.text.replace(/'/g, "''")}'`
				], { timeoutMs: 15e3 });
				if (!r.ok) return `写剪贴板失败，没发出去：${r.message}`;
				await new Promise((r2) => setTimeout(r2, 120));
				continue;
			}
			const input = await performInput({
				kind: "key",
				key: step.key,
				...step.modifiers === void 0 ? {} : { modifiers: step.modifiers }
			}, { allowedTitles: [] });
			if (!input.ok) return `按键「${step.key}」被拒，没发出去：${input.message}`;
			await new Promise((r2) => setTimeout(r2, 200));
		}
		return pending.text.trim() === "" ? `打开了和「${pending.to}」的会话，但你没说发什么，所以没发。` : `发了：给${pending.app}的「${pending.to}」——「${pending.text}」`;
	};
	/**
	
	* 跑一个通用任务：看着屏幕一步步做成。
	
	*
	
	* 这是「硬编码动作」的替代方案——播放音乐、搜索、发消息都走这一条路，
	
	* 和玩游戏共用同一套"截图→决定→注入→验证"的循环，只是目标不同。
	
	*
	
	* 每步都会检查急停；连续卡住或超步数就停手，不无限烧钱。
	
	*/
	const runTask = async (goal, opts = {}) => {
		const visionModel = resolveVisionModel();
		if (visionModel === void 0) return {
			ok: false,
			kind: "failed",
			summary: "没有可用的模型",
			steps: 0
		};
		const attachments = getAttachments();
		if (attachments === void 0) return {
			ok: false,
			kind: "failed",
			summary: "附件服务不可用",
			steps: 0
		};
		const maxSteps = Math.max(1, Math.min(50, opts.maxSteps ?? DEFAULT_TASK_CONFIG.maxSteps));
		const dryRun = opts.dryRun ?? DEFAULT_TASK_CONFIG.dryRun;
		const state$1 = createTaskState();
		let lastJpeg;
		for (let step = 1; step <= maxSteps; step++) {
			if (!autoplayEstop.canAct()) {
				const snap = autoplayEstop.snapshot();
				return {
					ok: false,
					kind: "stopped",
					summary: `急停：${snap.lastReason ?? "已停止"}`,
					steps: state$1.steps
				};
			}
			const shot = await captureScreen();
			const jpeg = Uint8Array.from(Buffer.from(shot.dataUrl.split(",")[1] ?? "", "base64"));
			const changed = lastJpeg === void 0 ? true : frameDiff(lastJpeg, jpeg) >= .01;
			lastJpeg = jpeg;
			try {
				await saveSnapshot(sightSnapshotsRoot, shot.dataUrl.split(",")[1] ?? "", readSightConfig().keepSnapshots);
			} catch {}
			const seen = await lookAtScreen(
				{
					llm: ctx.llm,
					attachments
				},
				jpeg,
				visionModel,
				// 与代打同一档：只输出一行动作（watch 档的系统提示要求「描述画面」，与动作格式冲突）
				"action",
				taskPrompt(goal, step, maxSteps),
				(refs) => void purgeAttachmentObjects(ctx, refs)
);
			if (!seen.ok) return {
				ok: false,
				kind: "failed",
				summary: seen.message,
				steps: state$1.steps
			};
			console.log("[dsh-whale-girl] 任务第 " + step + " 步模型输出：" + seen.text.slice(0, 200));
			const finished = parseTaskDone(seen.text);
			if (finished !== void 0) return {
				ok: true,
				kind: "done",
				summary: finished,
				steps: state$1.steps
			};
			const plan = parseActionPlan(seen.text, {
				width: shot.width,
				height: shot.height
			});
			if (plan.kind === "noop" || plan.kind === "invalid") {
				advanceTaskState(state$1, `跳过：${plan.kind === "noop" ? plan.reason : plan.reason}`, changed);
				const giveUp$1 = shouldGiveUp(state$1, maxSteps);
				if (giveUp$1.giveUp) return {
					ok: false,
					kind: "gaveup",
					summary: giveUp$1.reason,
					steps: state$1.steps
				};
				continue;
			}
			let executed = true;
			if (!dryRun) {
				autoplayEstop.markInjecting(true);
				try {
					for (const action of plan.actions) {
						const r = await performInput(action, {
							allowedTitles: opts.allowedTitles ?? [],
							matchesTitle: windowMatchesAllowed
						});
						if (!r.ok) {
							executed = false;
							return {
								ok: false,
								kind: "failed",
								summary: `动作被拒：${r.message}`,
								steps: state$1.steps
							};
						}
					}
				} finally {
					autoplayEstop.markInjecting(false);
				}
			}
			advanceTaskState(state$1, `${executed ? "" : "[空跑]"}${plan.actions.length} 个动作`, changed);
			const giveUp = shouldGiveUp(state$1, maxSteps);
			if (giveUp.giveUp) return {
				ok: false,
				kind: "gaveup",
				summary: giveUp.reason,
				steps: state$1.steps
			};
		}
		return {
			ok: false,
			kind: "gaveup",
			summary: `走了 ${state$1.steps} 步还没完成`,
			steps: state$1.steps
		};
	};
	const runSightOnce = async () => {
		const conf = readSightConfig();
		const round = await runSightRound(conf, {
			capture: () => captureScreen(),
			describe: async (jpeg, mode) => {
				const visionModel = pickFastVisionModel() ?? resolveVisionModel();
				if (visionModel === void 0) return {
					ok: false,
					reason: "no-model",
					message: "没解析到可用的识图模型"
				};
				const attachments = getAttachments();
				if (attachments === void 0) return {
					ok: false,
					reason: "attachments-missing",
					message: "附件服务不可用"
				};
				const recent = sightState.recent.slice(-4);
				const styleHint = mode === "watch" ? void 0 : [recent.length === 0 ? "" : "你最近几次搭话是：" + recent.map((text) => "「" + text + "」").join("、") + "。这次换个角度和开头，别重复这些说法，也别只复述画面。", "现在是" + timeContextOf(new Date()) + "。"].filter((part) => part !== "").join("\n");
				const result = await lookAtScreen(
					{
						llm: ctx.llm,
						attachments
					},
					jpeg,
					visionModel,
					mode,
					styleHint,
					// 落地即焚：调用一结束立刻删掉临时附件
					(refs) => {
						purgeAttachmentObjects(ctx, refs);
					}
);
				return result.ok ? {
					ok: true,
					text: result.text
				} : result;
			},
			persist: (jpegBase64, keep) => saveSnapshot(sightSnapshotsRoot, jpegBase64, keep),
			diff: frameDiff,
			parseReply: parseSightReply
		}, sightState);
		if (round.kind === "spoke") {
			sightState.lastReply = round.text;
			sightState.recent = [...sightState.recent, round.text].slice(-4);
			const petId = resolveActivePetId();
			state.writePet(
				petId,
				"say",
				// 识屏搭话默认只弹气泡；conf.speak 打开后由桌面渲染端念出来。
				round.speak ? {
					text: round.text,
					speak: true
				} : { text: round.text }
);
			console.log(`[dsh-whale-girl] 看屏幕说：${round.text}`);
			if (conf.memoryShared) try {
				const cfgNow = readAllConfig(configPaths);
				const mem = await readMemory();
				const found = findPetInstance(cfgNow, petId);
				const entryKey = found ? found.entry : "main";
				const bucket = mem[entryKey] ??= {};
				const record = bucket[petId] ??= { messages: [] };
				const now = Date.now();
				record.messages.push({
					role: "assistant",
					content: `（我看了眼屏幕，说：${round.text}）`,
					ts: now
				});
				const rounds = memoryRounds(petId, cfgNow);
				const keep = Math.max(0, rounds) * 2;
				if (keep > 0 && record.messages.length > keep) record.messages = record.messages.slice(-keep);
				await writeMemory(mem);
			} catch (e) {
				console.warn("[dsh-whale-girl] 识屏记忆写入失败：" + (e instanceof Error ? e.message : String(e)));
			}
		} else if (round.kind === "failed") console.warn(`[dsh-whale-girl] 识屏失败（${round.reason}）：${round.message}`);
		return round;
	};
	/**
	
	* 重排识屏定时器。
	
	*
	
	* 用 `setTimeout` 自链而不是 `setInterval`：一轮识屏要抓屏 + 调模型（秒级），
	
	* 固定间隔会在慢轮次上堆积请求。自链保证「上一轮跑完才开始计时下一轮」。
	
	*
	
	* 配置变更（POST /sight/config）会立刻调它重排，不用等重启。
	
	*/
	let sightTimer = null;
	const armSightTimer = () => {
		if (sightTimer !== null) {
			clearTimeout(sightTimer);
			sightTimer = null;
		}
		const conf = readSightConfig();
		if (!conf.enabled) return;
		const delayMs = nextSightDelayMs(conf);
		sightTimer = setTimeout(() => {
			sightTimer = null;
			(async () => {
				try {
					await runSightOnce();
				} catch (e) {
					console.warn("[dsh-whale-girl] 识屏异常：" + (e instanceof Error ? e.message : String(e)));
				} finally {
					armSightTimer();
				}
			})();
		}, delayMs);
	};
	/**
	
	* **会话实际在用的模型**（观察值）。
	
	*
	
	* 为什么不能只用 `agentDefaultModel.currentSelection()`：DSH 的文档写得很清楚——
	
	* 它「owns the **default** model selection independently of any Host or transport」，
	
	* 也就是**新会话的默认模型**，跟界面里给当前会话挑的那个可以是两码事。
	
	* 实测就撞上了：profile 里默认写的是 `workbuddy-ai`，而主人当前会话跑在
	
	* `deepseek-account/deepseek-flash` 上，插件却拿默认值去调用，直接吃了 429。
	
	*
	
	* 权威来源是 `agent/request` 瀑布：每一轮请求的最终 provider/model 都会从这里过一遍
	
	* （DSH 自己的会话级模型选择也是在这个瀑布里覆盖的，见 dsh-agent 的
	
	* `installModelSelection`）。我们只**旁听**：`await next()` 拿到解析结果，记下来，原样返回，
	
	* 绝不改配置。
	
	*
	
	* 没观察过（插件刚启动、还没跑过任何对话）时退回默认值——不能因为没数据就不出声。
	
	*/
	let observedSessionModel;
	/**
	
	* 把学到的会话模型**落盘**。
	
	*
	
	* 为什么必须存：观察值只活在进程内存里，DSH 一重启就没了。而插件刚启动、
	
	* 还没旁听到任何请求的那段时间，`resolveCurrentModel()` 只能退回
	
	* `agentDefaultModel` 的默认值——本机那个默认值是已经限流的 workbuddy-ai，
	
	* 于是「重启后第一次对话/语音必定失败一次」（主人实测踩到）。
	
	* 存下来后，重启读回上次学到的，冷启动窗口就不存在了。
	
	*/
	const observedModelPath = join(userRoot, "observed-model.json");
	try {
		const cached = JSON.parse(readFileSync(observedModelPath, "utf8"));
		if (typeof cached.provider === "string" && cached.provider !== "" && typeof cached.model === "string" && cached.model !== "") observedSessionModel = {
			provider: cached.provider,
			model: cached.model
		};
	} catch {}
	const persistObservedModel = (value) => {
		observedSessionModel = value;
		(async () => {
			try {
				await mkdir(userRoot, { recursive: true });
				await writeFile(observedModelPath, JSON.stringify(value, null, 2) + "\n", "utf8");
			} catch {}
		})();
	};
	ctx.effect(() => {
		try {
			return ctx.on("agent/request", async (_payload, next) => {
				const resolved = await next();
				try {
					const provider = resolved?.provider;
					const model = resolved?.model;
					if (typeof provider === "string" && provider !== "" && typeof model === "string" && model !== "") {
						if (observedSessionModel?.provider !== provider || observedSessionModel.model !== model) persistObservedModel({
							provider,
							model
						});
					}
				} catch {}
				return resolved;
			});
		} catch (e) {
			console.warn("[dsh-whale-girl] 无法旁听 agent/request（将退回默认模型）：" + (e instanceof Error ? e.message : String(e)));
			return () => {};
		}
	}, "dsh-whale-girl: observe session model");
	/**
	
	* 解析「当前对话该用哪个模型」：优先观察到的会话模型，其次 agentDefaultModel 的默认值。
	
	* 对话、语音、余额都走这一个出口，保证三处口径一致。
	
	*/
	const resolveCurrentModel = () => {
		if (observedSessionModel !== void 0) return observedSessionModel;
		try {
			const sel = ctx.agentDefaultModel.currentSelection();
			if (typeof sel?.provider === "string" && sel.provider !== "" && typeof sel.model === "string" && sel.model !== "") return {
				provider: sel.provider,
				model: sel.model
			};
		} catch {}
		return void 0;
	};
	/**
	
	* 语音设置：`$DSH_HOME/dsh-whale-girl/voice.json`（可选，不存在就用默认）。
	
	*
	
	* 为什么不塞进 config.jsonc：那份配置有严格的逐字段校验与「整段替换」语义，
	
	* 语音是主机侧能力（Python 路径、音色），与宠物外观无关；混进去会让
	
	* 「配置非法 → 宠物不显示」这类问题牵连语音。
	
	*
	
	* 字段全部可选：
	
	*   { "voice": "zh-CN-XiaoyiNeural", "rate": "+0%", "pythonPath": "C:\\...\\python.exe", "language": "zh" }
	
	*
	
	* 每次都重新读（文件很小），改完刷新页面即生效，不必重启。
	
	*/
	const readVoiceConfig = () => {
		const fallback = {
			voice: DEFAULT_VOICE,
			rate: DEFAULT_RATE
		};
		try {
			const raw = readFileSync(join(userRoot, "voice.json"), "utf8");
			const parsed = JSON.parse(raw);
			const voice = typeof parsed.voice === "string" && parsed.voice.trim() !== "" ? parsed.voice.trim() : fallback.voice;
			const rate = typeof parsed.rate === "string" && parsed.rate.trim() !== "" ? parsed.rate.trim() : fallback.rate;
			const pythonPath = typeof parsed.pythonPath === "string" && parsed.pythonPath.trim() !== "" ? parsed.pythonPath.trim() : void 0;
			const language = typeof parsed.language === "string" && parsed.language.trim() !== "" ? parsed.language.trim() : void 0;
			const shortcut = typeof parsed.shortcut === "string" && parsed.shortcut.trim() !== "" ? parsed.shortcut.trim() : void 0;
			const micDeviceId = typeof parsed.micDeviceId === "string" && parsed.micDeviceId.trim() !== "" ? parsed.micDeviceId.trim() : void 0;
			const hideButton = typeof parsed.hideButton === "string" && parsed.hideButton.trim() !== "" ? parsed.hideButton.trim() : void 0;
			const provider = parsed.provider === "gpt-sovits" ? "gpt-sovits" : parsed.provider === "edge" ? "edge" : void 0;
			const endpoint = typeof parsed.endpoint === "string" && parsed.endpoint.trim() !== "" ? parsed.endpoint.trim() : void 0;
			const style = typeof parsed.style === "string" && parsed.style.trim() !== "" ? parsed.style.trim() : void 0;
			return {
				voice,
				rate,
				pythonPath,
				language,
				shortcut,
				micDeviceId,
				hideButton,
				provider,
				endpoint,
				style
			};
		} catch {
			return fallback;
		}
	};
	const voiceHotkeyHub = createHotkeyHub();
	let voiceHotkeyWatcher;
	let voiceHotkeyDisplay = DEFAULT_VOICE_SHORTCUT;
	let voiceHotkeyError;
	/** 热键链路的诊断快照（/voice/hotkey 与 SSE 的 ready 帧都用它） */
	const voiceHotkeyStatus = () => ({
		ok: voiceHotkeyError === void 0 && voiceHotkeyWatcher?.running() === true,
		shortcut: voiceHotkeyDisplay,
		platform: process.platform,
		watcher: voiceHotkeyWatcher?.running() === true ? "running" : "stopped",
		clients: voiceHotkeyHub.clients(),
		...voiceHotkeyError === void 0 ? {} : { message: voiceHotkeyError }
	});
	/** 按当前 voice.json 的 shortcut 重建监听（插件启动、保存语音设置时都走这里） */
	const restartVoiceHotkey = () => {
		voiceHotkeyWatcher?.stop();
		voiceHotkeyWatcher = void 0;
		voiceHotkeyError = void 0;
		const shortcut = readVoiceConfig().shortcut ?? DEFAULT_VOICE_SHORTCUT;
		voiceHotkeyDisplay = shortcut;
		const parsed = parseHotkey(shortcut);
		if (!parsed.ok) {
			voiceHotkeyError = parsed.message;
			console.warn("[dsh-whale-girl] 全局语音热键不可用：" + parsed.message);
			return;
		}
		voiceHotkeyDisplay = parsed.display;
		voiceHotkeyWatcher = startHotkeyWatcher(parsed.spec, (event) => {
			voiceHotkeyHub.broadcast(event);
		});
		if (!voiceHotkeyWatcher.running()) {
			voiceHotkeyError = "热键监听没有起来（页面有焦点时快捷键仍可用）";
			console.warn("[dsh-whale-girl] " + voiceHotkeyError);
		}
	};
	/**
	
	* 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
	
	*   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
	
	*     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
	
	*   - 否则：用户目录 `$DSH_HOME/dsh-whale-girl/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
	
	*     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
	
	* 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
	
	* 路由必须取得到，否则气泡配图会图裂。
	
	* 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
	
	* rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
	
	*/
	const memeDirsFor = (assetRoot) => {
		const own = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own !== void 0 && existsSync(own)) return [own];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const workStatus = new WorkStatusStore();
	let publishedWork = "\0";
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task);
		if (key === publishedWork) return;
		publishedWork = key;
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task
		});
	};
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	const turnFlags = new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
	const terminalTimers = new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	const NOTIFY_ACTIVITY_DELAY_MS = 1500;
	/** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
	const notifyActivityTimers = new Map();
	/** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
	const sessionHasRunningWork = async (sessionId) => {
		const waterfall = ctx.waterfall;
		if (typeof waterfall !== "function") return false;
		try {
			const activity = await waterfall.call(ctx, "workspace/session-activity", { sessionId }, () => Promise.resolve([]));
			return hasBlockingActivity(activity);
		} catch {
			return false;
		}
	};
	/** 排一个活动门定时器：到点确认空闲才推这一帧 */
	const scheduleCompletionNotify = (sessionId, event) => {
		const prev = notifyActivityTimers.get(sessionId);
		if (prev !== void 0) clearTimeout(prev);
		notifyActivityTimers.set(sessionId, setTimeout(() => {
			notifyActivityTimers.delete(sessionId);
			(async () => {
				if (await sessionHasRunningWork(sessionId)) return;
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(frame);
			})();
		}, NOTIFY_ACTIVITY_DELAY_MS));
	};
	let activePetId = "";
	const lastWhisperAt = new Map();
	const memoryPath = join(userRoot, "memory.json");
	/**
	
	* 人设覆盖文件：主人自己写的人设放这里，优先于 config 的 whisperPrompt。
	
	* 为什么不直接改 main-config.jsonc：那份是结构化配置（有校验与整段替换语义），
	
	* 人设是长文本，单独一份文件更不容易被配置保存冲掉。
	
	*/
	const personaPath = join(userRoot, "persona.json");
	/**
	
	* 对话记录（与 memory.json **分开**）：主人随时翻阅用的完整来往，
	
	* 含被拆出去的动作/神态；**不参与模型上下文**。
	
	* 格式：{ entries: [{ ts, petId, user, speech, action, raw }] }
	
	*/
	const chatLogPath = join(userRoot, "chatlog.json");
	const CHAT_LOG_CAP = 2e3;
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") throw new Error("not an object");
			return parsed;
		} catch (e) {
			console.error(`dsh-whale-girl: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			try {
				await mkdir(userRoot, { recursive: true });
				await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, "utf8");
			} catch {}
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	const readChatLog = async () => {
		try {
			const parsed = JSON.parse(await readFile(chatLogPath, "utf8"));
			if (!Array.isArray(parsed.entries)) return [];
			return parsed.entries.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.ts === "number" && typeof entry.speech === "string");
		} catch {
			return [];
		}
	};
	const writeChatLog = async (entries) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(chatLogPath, JSON.stringify({ entries }, null, 2), "utf8");
	};
	const appendChatLog = async (petId, user, formatted, raw) => {
		const entries = await readChatLog();
		entries.push({
			ts: Date.now(),
			petId,
			user,
			speech: formatted.speech,
			action: formatted.action,
			raw
		});
		await writeChatLog(entries.length > CHAT_LOG_CAP ? entries.slice(-CHAT_LOG_CAP) : entries);
	};
	/**
	
	* 第一次打开「对话记录」时，用现有记忆播种（把导入的手机记录也变成可翻阅的记录）。
	
	* 只在 chatlog.json **不存在**时做一次；之后新对话自己追加。
	
	*/
	const seedChatLogFromMemory = async (petId) => {
		try {
			await readFile(chatLogPath, "utf8");
			return;
		} catch {}
		try {
			const mem = await readMemory();
			const cfg = readAllConfig(configPaths);
			const entryKey = findPetInstance(cfg, petId)?.entry ?? "main";
			const messages = mem[entryKey]?.[petId]?.messages ?? [];
			const entries = [];
			let pendingUser = "";
			for (const message of messages) {
				if (message.role === "user") {
					pendingUser = message.content;
					continue;
				}
				const formatted = splitChatReply(message.content);
				entries.push({
					ts: message.ts,
					petId,
					user: pendingUser,
					speech: message.content,
					action: formatted.action,
					raw: message.content
				});
				pendingUser = "";
			}
			await writeChatLog(entries.slice(-CHAT_LOG_CAP));
		} catch (e) {
			console.warn("[dsh-whale-girl] 对话记录播种失败：" + (e instanceof Error ? e.message : String(e)));
		}
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run$1 = chatQueue.then(fn, fn);
		chatQueue = run$1.then(() => void 0, () => void 0);
		return run$1;
	};
	/** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
	
	*  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。
	
	*  + 末尾追加一行**时间背景**（time-context.ts：日期/星期/时刻/时段/工作日或周末）：
	
	*    碎碎念与对话各自每次生成都会重新走这里，所以拿到的永远是**当前**时刻，不需要额外的刷新机制；
	
	*    非法 Date 时它为空串，此时整行不加（宁可没有时间信息，也不把 NaN 拼进提示词）。 */
	/**
	
	* 人设覆盖（persona.json 的 main 字段）。
	
	* 文件不存在/坏了/为空 → undefined（回落到 config 的 whisperPrompt，行为与旧版一致）。
	
	*/
	const readPersonaOverride = () => {
		try {
			const raw = JSON.parse(readFileSync(personaPath, "utf8"));
			return typeof raw.main === "string" && raw.main.trim() !== "" ? raw.main.trim() : void 0;
		} catch {
			return void 0;
		}
	};
	const petSystemPrompt = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const override = (found ? found.entry : "main") === "main" ? readPersonaOverride() : void 0;
		const prompt = override ?? (typeof conf.whisperPrompt === "string" ? conf.whisperPrompt : "");
		const name = found ? String(found.pet.name || found.pet.id || petId) : petId;
		const nameLine = "你的名字是“" + name + "”。";
		const base = prompt ? prompt + "\n" + nameLine : nameLine;
		const time = timeContextOf(new Date());
		return time ? base + "\n" + time : base;
	};
	/** 对话专用人设：碎碎念的底座 + 聊天规则（早先对话复用「20 字以内」的碎碎念人设，导致又短又呆） */
	const chatSystemPrompt = (petId, cfg) => petSystemPrompt(petId, cfg) + "\n\n【聊天规则】\n- 这次是在聊天，不是在碎碎念，也不是在汇报屏幕：一次自然地说 2~5 句，句长有变化。\n- **只写你说的话**：不要动作、神态、表情、心理描写，不要括号旁白（`（…）`），不要 `*…*`。\n  主人要的是纯聊天；带动作的版本由你另起一行用「【动作】…」记，那部分不会显示/朗读，只进对话记录。\n- 可以反问、吐槽、撒娇、讲自己的看法；不要只给结论，不要每句都用同样的开头或语气词。\n- 不要复述主人刚说的话；记忆里有前文就接着聊（提到之前的事、主人的心情或约定），别像第一次见面。\n- 上面「20 字以内」只适用于碎碎念，聊天时不适用。\n- 不要提「作为 AI / 模型」，不要解释你在做什么。";
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
	const memoryRounds = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
	
	*  每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say——
	
	*  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
	
	*  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
	
	*  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
	
	*  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。 */
	const publishWhisper = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const entry = found ? found.entry : "main";
		const system = petSystemPrompt(petId, cfg);
		const meme = conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : void 0;
		const result = await generateWhisper(ctx, system, meme, configuredModel(conf, "whisperModel"));
		if (!result.ok) {
			console.warn("[dsh-whale-girl] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return false;
		}
		state.writePet(petId, "say", result.image ? {
			text: result.text,
			image: result.image
		} : { text: result.text });
		return true;
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
	
	*  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
	
	*  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。 */
	const chatWithPet = async (petId, text, override, speakReply = true, preSight, style = "text") => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const rounds = memoryRounds(petId, cfg);
		const found = findPetInstance(cfg, petId);
		const conf = (found ?? { conf: cfg.main ?? {} }).conf;
		const baseSystem = style === "voice" ? chatSystemPrompt(petId, cfg) + "\n\n【语音回复】这段话会被念出来：用口语，2~4 句，不要列清单、不要 Markdown/表情符号；说完就停，别拖太长。" : chatSystemPrompt(petId, cfg);
		const pool = conf.chatImageEnabled === true ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? "main")), Number(conf.chatImageLimit)) : [];
		const mem = await readMemory();
		const bucketKey = found?.entry ?? petId;
		const bucket = mem[bucketKey] ??= {};
		const entry = bucket[petId] ??= { messages: [] };
		const list = sliceMemoryRounds(entry.messages, rounds);
		const recalled = selectRelevantMemory(entry.messages, text, {
			excludeLast: list.length,
			limit: 6
		});
		const memoryBlock = recalled.length === 0 ? "" : "\n\n【更早的相关记忆（可能不连续；用来接上主人提到的话题，别逐字复述）】\n" + recalled.map((message) => (message.role === "user" ? "主人：" : "你：") + message.content.slice(0, 300)).join("\n");
		const system = baseSystem + memoryBlock;
		const preferred = override ?? configuredModel(conf, "chatModel") ?? resolveCurrentModel();
		/**
		
		* 语音对话主动识屏：把抓到的多帧交给模型。
		
		*
		
		* 图片必须先过附件存储（DSH 的图片消息只认 ref），所以这里存一次、
		
		* 用完立刻删（与识屏同一条口径：落地即焚）。
		
		* 存不进去就**降级成纯文本**——看一眼失败不该让整轮对话失败。
		
		*/
		let pictures;
		let userTextWithNote = text;
		if (preSight !== void 0) {
			const attachments = getAttachments();
			if (attachments !== void 0) try {
				const refs = await attachments.saveImages(preSight.images.map((data, i) => ({
					data,
					mediaType: "image/jpeg",
					name: "voice-" + (i + 1) + ".jpg"
				})));
				pictures = refs;
				userTextWithNote = preSight.note + "\n" + text;
				purgeAttachmentObjects(ctx, refs);
			} catch (e) {
				console.warn("[dsh-whale-girl] 语音识屏附图失败，按纯文本继续：" + (e instanceof Error ? e.message : String(e)));
			}
		}
		let generated = await generateChat(ctx, system, list, userTextWithNote, pool, preferred, pictures);
		/**
		
		* 限流回落（文字与语音共用这一处）。
		
		*
		
		* 为什么必须在这里兜：插件刚启动时还没旁听到任何 `agent/request`，
		
		* `resolveCurrentModel()` 只能退回 `agentDefaultModel` 的**默认值**——
		
		* 而那个默认值可能早就不是主人在用的模型（实测就是 workbuddy-ai 额度用尽）。
		
		* 结果是「重启后第一次对话必定失败一次」，体验很差。
		
		*
		
		* 只对**明确的限流**回落：其它失败（缺凭证 / 模型不存在 / 网络）换一家只会掩盖问题。
		
		*/
		let usedFallback;
		if (!generated.ok && /429|soft_rate|rate.?limit|频率/i.test(generated.message ?? "")) {
			/**
			
			* 先**用同一个主候选重试一次**，再考虑换服务商。
			
			*
			
			* 原因：`generateChat` 内部本身有一条候选链（传入的 preferred → 当前默认模型）。
			
			* 主候选（会话实际模型）偶发失败时，它会自动回落到**默认模型**，而那个默认值
			
			* 可能正是已限流的 workbuddy-ai —— 于是最终报出来的 429 其实来自**兜底候选**，
			
			* 跟主候选无关。主人看到「限流」就以为模型识别又坏了。
			
			* 先重试主候选一次，能挡掉这类误报。
			
			*/
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
			const retry = await generateChat(ctx, system, list, text, pool, preferred);
			if (retry.ok) generated = retry;
			else {
				const currentProvider = (preferred ?? resolveCurrentModel())?.provider ?? "";
				const alt = await pickFallbackModel(currentProvider);
				if (alt !== void 0) {
					const second = await generateChat(ctx, system, list, text, pool, alt);
					if (second.ok) {
						generated = second;
						usedFallback = alt;
						persistObservedModel(alt);
						console.warn(`[dsh-whale-girl] 当前模型限流，已改用 ${alt.provider}/${alt.model} 重试成功`);
					}
				}
			}
		}
		if (!generated.ok) return generated;
		const now = Date.now();
		const formatted = splitChatReply(generated.text);
		entry.messages.push({
			role: "user",
			content: text,
			ts: now
		});
		entry.messages.push({
			role: "assistant",
			content: formatted.speech,
			ts: now
		});
		try {
			await seedChatLogFromMemory(petId);
		} catch {}
		await writeMemory(mem);
		try {
			await appendChatLog(petId, text, formatted, generated.text);
		} catch (e) {
			console.warn("[dsh-whale-girl] 写对话记录失败：" + (e instanceof Error ? e.message : String(e)));
		}
		state.writePet(
			petId,
			"say",
			// `speak` 是**给渲染端的口令**：这条回复该不该由桌面窗念出来。
			//  - 文字对话 → true（除此之外没有别的播放途径）
			//  - 语音对话 → false（调用方自己播；再让桌面窗播就是同一句两遍）
			// 碎碎念 / 广播永远没有这个字段，只弹气泡——不然她一整天在自言自语。
			speakReply ? generated.image ? {
				text: formatted.speech,
				image: generated.image,
				speak: true
			} : {
				text: formatted.speech,
				speak: true
			} : generated.image ? {
				text: formatted.speech,
				image: generated.image
			} : { text: formatted.speech }
);
		return {
			ok: true,
			text: formatted.speech,
			...generated.image ? { image: generated.image } : {},
			...usedFallback === void 0 ? {} : { fellBackTo: `${usedFallback.provider}/${usedFallback.model}` }
		};
	});
	/**
	
	* 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
	
	* 字段填满），命令与桌面模式都从这里取。
	
	*/
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300） */
	const whisperPeriodSec = (cfg, petId) => {
		const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
		const ers = conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	
	* 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
	
	*
	
	* 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
	
	* 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
	
	*
	
	* 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
	
	* 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
	
	*
	
	* @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
	
	*   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
	
	*   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
	
	*/
	/**
	
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
	
	* 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
	
	*
	
	* - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
	
	* - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
	
	* - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
	
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
		};
	};
	const refreshBalance = async (manual = false) => {
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const sel = resolveCurrentModel() ?? {
				provider: "",
				model: ""
			};
			const resolveKey$1 = async (ref) => {
				const rc = await ctx.credentials.resolve(credentialRef(ref));
				return rc?.value;
			};
			const resolveAccount = async () => {
				const account = ctx.get("deepseekAccount", false);
				if (!account) return void 0;
				return await account.getBalance(accountClientMetadata());
			};
			let result = await queryBalance(sel.provider, resolveKey$1, resolveAccount);
			if (!result.ok && result.reason === "unsupported") for (const candidate of ["deepseek-account", "deepseek-official"]) {
				const attempt = await queryBalance(candidate, resolveKey$1, resolveAccount);
				if (!attempt.ok) continue;
				const data = attempt.data;
				result = {
					...attempt,
					data: {
						...data,
						fallbackFrom: sel.provider
					}
				};
				break;
			}
			state.writeSection("balance", mark(result));
		} catch (e) {
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message: e instanceof Error ? e.message : String(e)
			}));
		}
	};
	/**
	
	* 限流回落时挑一个替代模型。
	
	*
	
	* 只在语音链路用（见 /voice/turn）：主人正对着麦克风说话，静默失败最伤，
	
	* 而 429 是**服务商额度**问题，换一家通常立刻可用。
	
	*
	
	* 选择顺序：DSH 账号（deepseek-account）→ DeepSeek 官方 → 其余任意有模型的服务商；
	
	* 同服务商内优先名字带 flash 的（便宜、快，适合闲聊）；当前服务商永远跳过。
	
	*/
	const pickFallbackModel = async (currentProvider) => {
		const llm = ctx.llm;
		if (!llm?.listProviders || !llm.listModels) return void 0;
		try {
			const providers = llm.listProviders();
			const rank = (id) => {
				const order = ["deepseek-account", "deepseek-official"];
				const i = order.indexOf(id);
				return i < 0 ? order.length : i;
			};
			const ordered = [...providers].sort((a, b) => rank(a.id) - rank(b.id));
			for (const provider of ordered) {
				if (provider.id === currentProvider) continue;
				try {
					const models = await llm.listModels(provider.id);
					if (models.length === 0) continue;
					const hit = models.find((m) => /flash/i.test(m.id)) ?? models[0];
					return {
						provider: provider.id,
						model: hit.id
					};
				} catch {}
			}
		} catch {}
		return void 0;
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
			return String(eff[0].id);
		} catch {
			return activePetId;
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		const n = String(pet.name ?? "").trim();
		return n || String(pet.id ?? "");
	};
	let hasDesktopPet = false;
	const refreshDesktop = () => {
		hasDesktopPet = false;
		try {
			hasDesktopPet = effectivePetList().some((p) => isDesktopVisible$1(p.display));
		} catch (e) {
			ctx.logger?.warn?.(`[dsh-whale-girl] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	refreshDesktop();
	/** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((p) => isDesktopVisible$1(p.display)).map((p) => ({
				id: String(p.id),
				size: Number(p.size)
			}));
		} catch {
			return [];
		}
	};
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	/** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
	let displayWarned = false;
	/** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
	const launchHelper = (electronPath) => {
		if (helper || disposed) return;
		if (!hasDesktopPet) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		const origin = `http://127.0.0.1:${port}`;
		const siteUrl = ctx.connection.authenticatedUrl(origin);
		const configUrl = `${origin}${ROUTE_PREFIX}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_WHALE_CONFIG_URL: configUrl,
				DSH_WHALE_SITE_URL: siteUrl,
				DSH_WHALE_OPEN_TARGET: isDesktopHost() ? "desktop" : "site",
				DSH_WHALE_SCALE: "1",
				DSH_WHALE_BRIDGE: "1",
				DSH_WHALE_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
				if (result.kind === "file") return {
					id: req.id,
					status: 200,
					contentType: result.contentType,
					file: result.file
				};
				if (result.kind === "text") return {
					id: req.id,
					status: result.status,
					contentType: "text/plain; charset=utf-8",
					body: result.body
				};
				if (result.kind === "buffer") return {
					id: req.id,
					status: 501,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify({
						ok: false,
						reason: "bridge-unsupported",
						message: "二进制响应不能走 bridge，请用 HTTP"
					})
				};
				return {
					id: req.id,
					status: result.status,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify(result.obj)
				};
			}
		}, ctx.logger ?? console);
		try {
			helper.start();
			ctx.logger?.info?.(`dsh-whale-girl desktop helper started (config: ${configUrl})`);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-whale-girl desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	/** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
	
	*  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
	const startHelper = () => {
		if (helper || electronEnsure || disposed) return;
		if (!hasDesktopPet) return;
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				ctx.logger?.warn?.("[dsh-whale-girl] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_WHALE_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		console.warn(`[dsh-whale-girl] Electron not found, downloading to ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload().then((path) => {
			if (path) launchHelper(path);
			else console.warn("[dsh-whale-girl] Electron download failed; desktop pet unavailable. Set DSH_WHALE_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	/** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	/** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	/**
	
	* 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
	
	*
	
	* 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
	
	* 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
	
	* 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
	
	* 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
	
	*/
	let desktopSyncQueue = Promise.resolve();
	const syncDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			refreshDesktop();
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			ctx.logger?.warn?.(`[dsh-whale-girl] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	/** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	/** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	/** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	/** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
	
	*  输入只需 rawUrl(/dsh-whale-girl/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
	
	*  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。 */
	const handlePetRoute = async (rawUrl, method, body) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
		if (rest === "diag") {
			let defaultSelection;
			try {
				defaultSelection = ctx.agentDefaultModel.currentSelection();
			} catch (e) {
				defaultSelection = { error: e instanceof Error ? e.message : String(e) };
			}
			let speech;
			try {
				const stt = ctx.get?.("speechToText", false) ?? ctx.speechToText;
				const snap = stt?.snapshot?.();
				speech = snap === void 0 ? "unavailable" : {
					selection: snap.selection,
					providers: snap.providers?.map((p) => p.id)
				};
			} catch (e) {
				speech = { error: e instanceof Error ? e.message : String(e) };
			}
			let modelCatalog;
			try {
				const llm = ctx.llm;
				modelCatalog = llm?.listProviders?.()?.map((p) => p.id);
			} catch (e) {
				modelCatalog = { error: e instanceof Error ? e.message : String(e) };
			}
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					plugin: "dsh-whale-girl",
					routePrefix: ROUTE_PREFIX,
					observedSessionModel: observedSessionModel ?? null,
					defaultSelection,
					resolvedModel: resolveCurrentModel() ?? null,
					llmProviders: modelCatalog,
					speech,
					voice: readVoiceConfig()
				}
			};
		}
		if (rest === "diag/model-info") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const provider = url.searchParams.get("provider") ?? "";
			const model = url.searchParams.get("model") ?? "";
			if (provider === "" || model === "") return {
				kind: "json",
				status: 400,
				obj: {
					ok: false,
					message: "需要 provider 与 model 参数"
				}
			};
			const llm = ctx.llm;
			if (typeof llm?.resolveModelInfo !== "function") return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					message: "llm.resolveModelInfo 不可用"
				}
			};
			try {
				const info = await llm.resolveModelInfo(provider, model);
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						provider,
						model,
						info
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "diag/llm-latency") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const provider = url.searchParams.get("provider") ?? "";
			const model = url.searchParams.get("model") ?? "";
			const effort = url.searchParams.get("effort") ?? void 0;
			if (provider === "" || model === "") return {
				kind: "json",
				status: 400,
				obj: {
					ok: false,
					message: "需要 provider 与 model 参数"
				}
			};
			const result = await probeModelLatency({ llm: ctx.llm }, {
				provider,
				model
			}, effort);
			return {
				kind: "json",
				status: 200,
				obj: {
					provider,
					model,
					effort: effort ?? null,
					...result
				}
			};
		}
		if (rest === "config") {
			if (method === "GET") try {
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths),
					headers: { "cache-control": "no-cache, no-store" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			if (method === "PUT") try {
				const parsed = JSON.parse(body ?? "");
				const existing = readUserConfig(configPaths);
				const clean = saveUserConfig(parsed, existing);
				if (!clean) return {
					kind: "json",
					status: 400,
					obj: { error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）" }
				};
				if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return {
					kind: "json",
					status: 409,
					obj: {
						error: "user config is unparsable",
						needConfirm: true,
						userFile: userConfigPath
					}
				};
				await mkdir(userRoot, { recursive: true });
				await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (method === "POST") {
				try {
					syncUserConfigFromDefault(configPaths);
				} catch (e) {
					return {
						kind: "json",
						status: 500,
						obj: { error: e instanceof Error ? e.message : String(e) }
					};
				}
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "pet-display") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let payload;
			try {
				payload = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const petId$1 = typeof payload.id === "string" ? payload.id.trim() : "";
			const nextDisplay = String(payload.display ?? "");
			if (!petId$1) return {
				kind: "json",
				status: 400,
				obj: { error: "missing pet id" }
			};
			if (!PET_DISPLAY_SET.has(nextDisplay)) return {
				kind: "json",
				status: 400,
				obj: { error: `invalid display: ${nextDisplay}` }
			};
			let merged;
			try {
				merged = readAllConfig(configPaths);
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			const hit = findPetInstance(merged, petId$1);
			if (!hit) return {
				kind: "json",
				status: 404,
				obj: { error: `pet not found: ${petId$1}` }
			};
			let layerPath;
			let layerDir;
			let existing;
			if (hit.entry === "main") {
				layerPath = userConfigPath;
				layerDir = userRoot;
				existing = readUserConfig(configPaths);
			} else {
				const file$1 = readPetConfigEntry(configPaths, hit.entry);
				if (!file$1) return {
					kind: "json",
					status: 404,
					obj: { error: `pet config file not found: ${hit.entry}` }
				};
				layerPath = file$1.path;
				layerDir = petConfigDir;
				existing = file$1.raw;
			}
			const layerPets = Array.isArray(hit.conf.pets) ? hit.conf.pets : [];
			const pets = layerPets.map((p) => String(p.id) === petId$1 ? {
				...p,
				display: nextDisplay
			} : p);
			const clean = saveUserConfig({ pets }, existing);
			if (!clean) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid pet config" }
			};
			try {
				await mkdir(layerDir, { recursive: true });
				await writeFile(layerPath, JSON.stringify(clean, null, 2), "utf8");
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: readAllConfig(configPaths)
			};
		}
		if (rest === "reload") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: { reloading: true }
			};
		}
		if (rest === "config/meta") return {
			kind: "json",
			status: 200,
			obj: {
				user: userConfigPath,
				default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
				animations: thumbUserRoot,
				memes: memesUserRoot,
				storage: storageEntries({
					userDataRoot: userRoot,
					electronDir: electronLandingDir(),
					home: homedir(),
					packageRoot: PACKAGE_ROOT
				}),
				profile: profileNameFrom(PACKAGE_ROOT) ?? ""
			}
		};
		if (rest === "models") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const llm = ctx.llm;
				const named = (id, name) => {
					const pid = String(id ?? "");
					return {
						id: pid,
						name: String(name ?? "") || pid
					};
				};
				let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
				if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
				providers = providers.filter((p) => p.id);
				const catalog = await Promise.all(providers.map(async (p) => {
					let models = [];
					try {
						const list = await llm?.listModels?.(p.id);
						models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
					} catch {}
					return {
						...p,
						models
					};
				}));
				return {
					kind: "json",
					status: 200,
					obj: { providers: catalog }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		if (rest === "state") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			return {
				kind: "json",
				status: 200,
				obj: {
					...state.read(),
					configVersion: configVersion(configPaths)
				},
				headers: { "cache-control": "no-cache, no-store" }
			};
		}
		if (rest === "balance") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			await refreshBalance(true);
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "whisper") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const petId$1 = String(url.searchParams.get("pet") ?? "");
			try {
				const ok = await publishWhisper(petId$1);
				return {
					kind: "json",
					status: 200,
					obj: ok ? { ok: true } : {
						ok: false,
						reason: "generate-error"
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "broadcast") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			if (!normalizeBroadcastText(o.text)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "text 为空"
				}
			};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBroadcast({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					text: o.text,
					image: o.image,
					memeDirs: memeDirsFor
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "say", d.image ? {
					text: d.text,
					image: d.image
				} : { text: d.text });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "anim") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideAnim({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					name: o.name
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "anim", { name: d.name });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "persona") {
			if (method === "GET") {
				const override = readPersonaOverride();
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						prompt: override ?? "",
						source: override === void 0 ? "config" : "persona.json"
					}
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const parsed = JSON.parse(body ?? "null") ?? {};
				const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
				await mkdir(userRoot, { recursive: true });
				await writeFile(personaPath, JSON.stringify(prompt === "" ? {} : { main: prompt }, null, 2) + "\n", "utf8");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						prompt,
						source: prompt === "" ? "config" : "persona.json"
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "memory" || rest === "memory/export" || rest === "memory/import" || rest === "memory/clear") {
			let parsedBody = {};
			if (method === "POST") try {
				parsedBody = JSON.parse(body ?? "null") ?? {};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: {
						ok: false,
						message: "invalid JSON body"
					}
				};
			}
			const requested = String(parsedBody.pet ?? url.searchParams.get("pet") ?? "").trim();
			const petId$1 = requested !== "" ? requested : resolveActivePetId() || "main";
			const cfgNow = readAllConfig(configPaths);
			const entryKey = findPetInstance(cfgNow, petId$1)?.entry ?? "main";
			if (rest === "memory" && method === "GET") {
				const mem = await readMemory();
				const messages = mem[entryKey]?.[petId$1]?.messages ?? [];
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						pet: petId$1,
						entry: entryKey,
						count: messages.length,
						messages: messages.slice(-20)
					}
				};
			}
			if (rest === "memory/export") {
				const mem = await readMemory();
				const messages = mem[entryKey]?.[petId$1]?.messages ?? [];
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						pet: petId$1,
						entry: entryKey,
						...exportMemoryPayload(messages)
					}
				};
			}
			if (rest === "memory/clear") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				await withMemoryLock(async () => {
					const mem = await readMemory();
					if (mem[entryKey]?.[petId$1]) mem[entryKey][petId$1].messages = [];
					await writeMemory(mem);
				});
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						pet: petId$1,
						cleared: true
					}
				};
			}
			if (rest === "memory/import") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				const parsedImport = parseMemoryImport(parsedBody.payload ?? parsedBody.messages ?? parsedBody.text);
				if (!parsedImport.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						message: parsedImport.message
					}
				};
				const merged = await withMemoryLock(async () => {
					const mem = await readMemory();
					const bucket = mem[entryKey] ??= {};
					const record = bucket[petId$1] ??= { messages: [] };
					const result = mergeMemory(record.messages, parsedImport.messages, 2e3);
					record.messages = result.messages;
					await writeMemory(mem);
					return result;
				});
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						pet: petId$1,
						entry: entryKey,
						imported: parsedImport.messages.length,
						added: merged.added,
						total: merged.messages.length
					}
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "chatlog" || rest === "chatlog/export" || rest === "chatlog/clear") {
			let parsedBody = {};
			if (method === "POST") try {
				parsedBody = JSON.parse(body ?? "null") ?? {};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: {
						ok: false,
						message: "invalid JSON body"
					}
				};
			}
			const requested = String(parsedBody.pet ?? url.searchParams.get("pet") ?? "").trim();
			const petId$1 = requested !== "" ? requested : resolveActivePetId() || "main";
			if (rest === "chatlog/clear") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				const kept = (await readChatLog()).filter((entry) => entry.petId !== petId$1);
				await writeChatLog(kept);
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						pet: petId$1,
						cleared: true
					}
				};
			}
			await seedChatLogFromMemory(petId$1);
			const all = (await readChatLog()).filter((entry) => entry.petId === petId$1);
			if (rest === "chatlog/export") return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					pet: petId$1,
					entries: all
				}
			};
			const limitRaw = Number(url.searchParams.get("limit") ?? "50");
			const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.round(limitRaw))) : 50;
			const beforeRaw = Number(url.searchParams.get("before") ?? "");
			const filtered = Number.isFinite(beforeRaw) && beforeRaw > 0 ? all.filter((entry) => entry.ts < beforeRaw) : all;
			const page = filtered.slice(-limit).reverse();
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					pet: petId$1,
					entries: page,
					hasMore: filtered.length > page.length
				}
			};
		}
		if (rest === "chat") {
			const petId$1 = String(url.searchParams.get("pet") ?? "");
			try {
				if (method === "GET") {
					const cfg = readAllConfig(configPaths);
					const mem = await readMemory();
					const bucket = mem[findPetInstance(cfg, petId$1)?.entry ?? petId$1] ?? {};
					const list = (bucket[petId$1]?.messages ?? []).slice();
					const rounds = memoryRounds(petId$1, cfg);
					const messages = sliceMemoryRounds(list, rounds);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							messages,
							rounds
						}
					};
				}
				if (method === "POST") {
					const parsed = JSON.parse(body ?? "null") ?? {};
					const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (!text) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息为空"
						}
					};
					if (text.length > 2e3) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息过长（限 2000 字）"
						}
					};
					const result = await chatWithPet(petId$1, text);
					return {
						kind: "json",
						status: 200,
						obj: result
					};
				}
				return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "voice/trace") {
			const file$1 = join(userRoot, "voice-trace.log");
			if (method === "GET") {
				let lines = [];
				try {
					lines = readFileSync(file$1, "utf8").split("\n").filter((l) => l !== "").slice(-60);
				} catch {}
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						lines
					}
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const parsed = JSON.parse(body ?? "null") ?? {};
				const line = JSON.stringify({
					at: new Date().toISOString(),
					step: String(parsed.step ?? ""),
					detail: parsed.detail === void 0 ? void 0 : parsed.detail
				});
				await mkdir(userRoot, { recursive: true });
				await appendFile(file$1, line + "\n", "utf8");
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest.startsWith("autoplay/")) {
			const sub = rest.slice(9);
			if (sub === "config") {
				if (method === "GET") return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						config: readAutoplayConfig(),
						estop: autoplayEstop.snapshot()
					}
				};
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				let patch;
				try {
					patch = JSON.parse(body ?? "null") ?? {};
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: {
							ok: false,
							message: "invalid JSON body"
						}
					};
				}
				try {
					const current = readAutoplayConfig();
					const next = normalizeAutoplayConfig({
						enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
						dryRun: typeof patch.dryRun === "boolean" ? patch.dryRun : current.dryRun,
						estopKey: typeof patch.estopKey === "string" ? patch.estopKey : current.estopKey,
						windowTitles: Array.isArray(patch.windowTitles) ? patch.windowTitles.filter((v) => typeof v === "string") : current.windowTitles,
						visionModel: patch.visionModel === null ? void 0 : patch.visionModel ?? current.visionModel
					});
					await mkdir(userRoot, { recursive: true });
					await writeFile(autoplayConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
					await rearmAutoplay(next);
					if (!next.enabled) {
						playLoop.stop("disabled");
						if (autoplaySession !== void 0) await endAutoplaySession();
					}
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							config: next,
							estop: autoplayEstop.snapshot()
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "run") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				const conf = readAutoplayConfig();
				if (!conf.enabled) return {
					kind: "json",
					status: 200,
					obj: {
						kind: "skipped",
						reason: "disabled"
					}
				};
				return {
					kind: "json",
					status: 200,
					obj: await runAutoplayOnce(conf)
				};
			}
			if (sub === "resume") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				autoplayEstop.resume();
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						estop: autoplayEstop.snapshot()
					}
				};
			}
			if (sub === "stop") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				autoplayEstop.stop("manual");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						estop: autoplayEstop.snapshot()
					}
				};
			}
			if (sub === "foreground") {
				if (method !== "GET") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							title: await foregroundWindowTitle()
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "windows") {
				if (method !== "GET") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					const subprocess = ctx.get("subprocess", false);
					const wins = await listWindows(subprocess);
					const seen = new Set();
					const windows = wins.filter((w) => {
						if (w.title.trim() === "" || seen.has(String(w.pid))) return false;
						seen.add(String(w.pid));
						return true;
					}).slice(0, 60).map((w) => ({
						pid: w.pid,
						title: w.title,
						processName: w.processName
					}));
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							windows
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "play") {
				if (method !== "GET") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						play: playLoop.snapshot(),
						config: readAutoplayConfig(),
						estop: autoplayEstop.snapshot()
					}
				};
			}
			if (sub === "play/start") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				let patch = {};
				try {
					patch = JSON.parse(body ?? "null") ?? {};
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: {
							ok: false,
							message: "invalid JSON body"
						}
					};
				}
				try {
					const started = await beginPlay(patch);
					if (!started.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: started.message
						}
					};
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							play: playLoop.snapshot(),
							config: readAutoplayConfig(),
							estop: autoplayEstop.snapshot()
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "play/stop") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				const ended = await stopPlayNow("manual");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						play: playLoop.snapshot(),
						estop: autoplayEstop.snapshot(),
						ended: ended ?? null
					}
				};
			}
			if (sub === "task") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					const patch = JSON.parse(body ?? "null") ?? {};
					const text = typeof patch.text === "string" ? patch.text.trim() : "";
					const routed = routeTask(text);
					if (routed.kind === "self") return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							route: "self",
							action: routed.action,
							reason: routed.reason
						}
					};
					if (routed.kind === "chat") return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							route: "chat",
							reason: routed.reason
						}
					};
					const sel = resolveCurrentModel();
					const created = await createTaskSession(ctx.get("agents", false), routed.prompt, {
						...typeof patch.cwd === "string" && patch.cwd !== "" ? { cwd: patch.cwd } : {},
						...sel === void 0 ? {} : {
							provider: sel.provider,
							model: sel.model
						}
					});
					return {
						kind: "json",
						status: 200,
						obj: {
							...created,
							route: "session",
							reason: routed.reason
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "games") {
				if (method === "GET") return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						games: await readGames(),
						genreCaps: GENRE_MEMORY_CAP
					}
				};
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					const patch = JSON.parse(body ?? "null") ?? {};
					const profile = normalizeProfile(patch);
					await writeGame(profile);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							game: profile
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "guide") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					const patch = JSON.parse(body ?? "null") ?? {};
					const title = typeof patch.title === "string" ? patch.title.trim() : "";
					const result = await searchGuide(ctx.get("web", false), title);
					if (!result.ok) return {
						kind: "json",
						status: 200,
						obj: result
					};
					const games = await readGames();
					const existing = games.find((g) => g.title === title || g.id === profileIdFromTitle(title));
					const merged = normalizeProfile({
						...existing ?? {
							title,
							genre: "custom"
						},
						title,
						guide: {
							query: result.query,
							summary: result.summary,
							sources: result.sources,
							atMs: result.atMs
						}
					});
					await writeGame(merged);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							guide: result,
							game: merged
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			if (sub === "session") {
				if (method !== "GET") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						session: autoplaySession === void 0 ? null : {
							gameTitle: autoplaySession.gameTitle,
							steps: autoplaySession.steps.length,
							cap: autoplaySession.cap,
							startedAt: autoplaySession.startedAt
						}
					}
				};
			}
			if (sub === "end") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				const ended = await stopPlayNow("end-session");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						ended: ended ?? null,
						play: playLoop.snapshot(),
						estop: autoplayEstop.snapshot()
					}
				};
			}
			if (sub === "toggle") {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				try {
					if (playLoop.snapshot().running) {
						const ended = await stopPlayNow("manual");
						return {
							kind: "json",
							status: 200,
							obj: {
								ok: true,
								running: false,
								play: playLoop.snapshot(),
								estop: autoplayEstop.snapshot(),
								ended: ended ?? null
							}
						};
					}
					const started = await beginPlay();
					if (!started.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: started.message
						}
					};
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							running: true,
							play: playLoop.snapshot(),
							config: readAutoplayConfig(),
							estop: autoplayEstop.snapshot()
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			return {
				kind: "json",
				status: 404,
				obj: { error: "unknown autoplay route" }
			};
		}
		if (rest === "sight/toggle") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const current = readSightConfig();
			const next = {
				...current,
				enabled: !current.enabled
			};
			await mkdir(userRoot, { recursive: true });
			await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
			armSightTimer();
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					enabled: next.enabled
				}
			};
		}
		if (rest === "sight/config") {
			if (method === "GET") {
				const usage = await snapshotUsage(sightSnapshotsRoot);
				const conf = readSightConfig();
				const resolvedVision = resolveVisionModel();
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						config: conf,
						snapshots: usage,
						dir: sightSnapshotsRoot,
						visionModelResolved: resolvedVision ?? null
					}
				};
			}
			if (method === "POST") {
				let patch;
				try {
					patch = JSON.parse(body ?? "null") ?? {};
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: {
							ok: false,
							message: "invalid JSON body"
						}
					};
				}
				try {
					const current = readSightConfig();
					const next = normalizeSightConfig({
						enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
						intervalSec: Number(patch.intervalSec ?? current.intervalSec),
						keepSnapshots: Number(patch.keepSnapshots ?? current.keepSnapshots),
						changeThreshold: Number(patch.changeThreshold ?? current.changeThreshold),
						speak: typeof patch.speak === "boolean" ? patch.speak : current.speak,
						mode: typeof patch.mode === "string" ? patch.mode : current.mode,
						windowTitle: typeof patch.windowTitle === "string" ? patch.windowTitle : current.windowTitle
					});
					await mkdir(userRoot, { recursive: true });
					await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
					armSightTimer();
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							config: next
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "sight/run") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const round = await runSightOnce();
			return {
				kind: "json",
				status: 200,
				obj: round
			};
		}
		if (rest === "apps/aliases") {
			if (method === "GET") return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					aliases: readAppAliases(),
					defaults: DEFAULT_APP_ALIASES
				}
			};
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const patch = JSON.parse(body ?? "null") ?? {};
				const next = {};
				for (const [k, v] of Object.entries(patch)) if (typeof v === "string" && k.trim() !== "" && v.trim() !== "") next[k.trim()] = v.trim();
				await mkdir(userRoot, { recursive: true });
				await writeFile(appsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						aliases: readAppAliases()
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "sight/snapshots") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let files = [];
			try {
				files = (await readdir(sightSnapshotsRoot)).filter((n) => n.endsWith(".jpg")).sort();
			} catch {}
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					files
				}
			};
		}
		if (rest.startsWith("sight/snapshot/")) {
			const name = rest.slice(15);
			if (name === "" || name.includes("/") || name.includes("\\") || !name.endsWith(".jpg")) return {
				kind: "text",
				status: 400,
				body: "dsh-whale-girl: invalid snapshot name"
			};
			const file$1 = join(sightSnapshotsRoot, name);
			if (!existsSync(file$1)) return {
				kind: "text",
				status: 404,
				body: "dsh-whale-girl: snapshot not found"
			};
			return {
				kind: "file",
				file: file$1,
				contentType: "image/jpeg"
			};
		}
		if (rest === "voice/config") {
			if (method === "GET") return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					...readVoiceConfig()
				}
			};
			if (method === "POST") {
				let patch;
				try {
					patch = JSON.parse(body ?? "null") ?? {};
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: {
							ok: false,
							message: "invalid JSON body"
						}
					};
				}
				try {
					const current = readVoiceConfig();
					const next = {
						voice: current.voice,
						rate: current.rate
					};
					if (current.pythonPath !== void 0) next.pythonPath = current.pythonPath;
					if (current.language !== void 0) next.language = current.language;
					if (current.shortcut !== void 0) next.shortcut = current.shortcut;
					if (current.micDeviceId !== void 0) next.micDeviceId = current.micDeviceId;
					if (current.hideButton !== void 0) next.hideButton = current.hideButton;
					for (const key of [
						"voice",
						"rate",
						"pythonPath",
						"language",
						"shortcut",
						"micDeviceId",
						"hideButton"
					]) {
						const value = patch[key];
						if (typeof value === "string" && value.trim() !== "") next[key] = value.trim();
						else if (value === "") delete next[key];
					}
					await mkdir(userRoot, { recursive: true });
					await writeFile(join(userRoot, "voice.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
					restartVoiceHotkey();
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							...readVoiceConfig(),
							hotkey: voiceHotkeyStatus()
						}
					};
				} catch (e) {
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							message: e instanceof Error ? e.message : String(e)
						}
					};
				}
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "voice/hotkey") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			return {
				kind: "json",
				status: 200,
				obj: voiceHotkeyStatus()
			};
		}
		if (rest === "voice/asr" || rest === "voice/turn" || rest === "voice/tts") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null") ?? {};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: {
						ok: false,
						reason: "bad-request",
						message: "invalid JSON body"
					}
				};
			}
			const voiceCfg = readVoiceConfig();
			if (rest === "voice/tts") {
				const text = typeof parsed.text === "string" ? parsed.text : "";
				const tts = await synthesize(userRoot, text, {
					voice: typeof parsed.voice === "string" ? parsed.voice : voiceCfg.voice,
					rate: typeof parsed.rate === "string" ? parsed.rate : voiceCfg.rate,
					pythonPath: voiceCfg.pythonPath,
					provider: voiceCfg.provider,
					endpoint: voiceCfg.endpoint,
					style: typeof parsed.style === "string" ? parsed.style : voiceCfg.style
				});
				if (!tts.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: tts.reason,
						message: tts.message
					}
				};
				if (url.searchParams.get("encoding") === "base64") return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						mime: tts.mime,
						audio: Buffer.from(tts.audio).toString("base64")
					}
				};
				return {
					kind: "buffer",
					status: 200,
					body: tts.audio,
					contentType: tts.mime
				};
			}
			const audio = typeof parsed.audio === "string" ? decodeAudioBase64(parsed.audio) : void 0;
			if (audio === void 0) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "缺少或无法解码 audio"
				}
			};
			const asr = await transcribe(ctx, audio, { language: voiceCfg.language });
			if (!asr.ok) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: asr.reason,
					message: asr.message
				}
			};
			if (rest === "voice/asr") return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					text: asr.text,
					audioSeconds: asr.audioSeconds
				}
			};
			const requested = String(parsed.pet ?? "");
			const petId$1 = requested.trim() === "" ? resolveActivePetId() : requested;
			if (!petId$1) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "no-pet",
					message: "没有可对话的宠物"
				}
			};
			if (playLoop.snapshot().running) {
				const spoken = asr.text.trim();
				if (spoken === "") {
					const sorry = "没听清，再说一次？";
					state.writePet(petId$1, "say", { text: sorry });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: "",
							reply: sorry,
							audioSeconds: asr.audioSeconds,
							route: "coach"
						}
					};
				}
				const spokenIntent = parseVoiceIntent(spoken);
				if (spokenIntent?.kind === "stop-now") {
					await stopPlayNow("voice");
					const bye = "好，先停在这。";
					state.writePet(petId$1, "say", { text: bye });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: spoken,
							reply: bye,
							audioSeconds: asr.audioSeconds,
							route: "coach"
						}
					};
				}
				autoplayUserHint = spoken.slice(0, 200);
				const ack = "收到：" + autoplayUserHint;
				state.writePet(petId$1, "say", { text: ack });
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						userText: spoken,
						reply: ack,
						audioSeconds: asr.audioSeconds,
						route: "coach"
					}
				};
			}
			if (pendingMessage !== void 0) {
				if (isConfirm(asr.text)) {
					const done = await executePendingMessage();
					state.writePet(petId$1, "say", { text: done });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: asr.text,
							reply: done,
							audioSeconds: asr.audioSeconds,
							route: "send"
						}
					};
				}
				if (isCancel(asr.text)) {
					pendingMessage = void 0;
					const done = "好，不发了。";
					state.writePet(petId$1, "say", { text: done });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: asr.text,
							reply: done,
							audioSeconds: asr.audioSeconds,
							route: "send"
						}
					};
				}
			}
			const intent = parseVoiceIntent(asr.text);
			if (intent !== void 0) {
				const done = await runVoiceIntent(intent, petId$1);
				if (done !== void 0) {
					state.writePet(petId$1, "say", { text: done });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: asr.text,
							reply: done,
							audioSeconds: asr.audioSeconds,
							intent: intent.kind
						}
					};
				}
			}
			if (intent === void 0) {
				const routed = routeTask(asr.text);
				if (routed.kind === "self") {
					const done = await runSelfAction(routed.action);
					if (done !== void 0) {
						state.writePet(petId$1, "say", { text: done });
						return {
							kind: "json",
							status: 200,
							obj: {
								ok: true,
								userText: asr.text,
								reply: done,
								audioSeconds: asr.audioSeconds,
								route: "self"
							}
						};
					}
				} else if (routed.kind === "session") {
					const sel = resolveCurrentModel();
					const created = await createTaskSession(ctx.get("agents", false), routed.prompt, sel === void 0 ? {} : {
						provider: sel.provider,
						model: sel.model
					});
					const reply = created.ok ? `好，我在 DSH 开了个会话去做：${created.title}` : `没能开会话：${created.message}`;
					state.writePet(petId$1, "say", { text: reply });
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							userText: asr.text,
							reply,
							audioSeconds: asr.audioSeconds,
							route: "session"
						}
					};
				}
			}
			const sightConf = readSightConfig();
			let preSight;
			const wantsLook = intent?.kind === "look-now" || shouldLookAtScreen(asr.text, sightConf.voiceVision);
			if (wantsLook) try {
				const plan = framePlan(sightConf.voiceFrames, sightConf.voiceFrameGapMs);
				const frames = await captureFrames(plan.count, plan.gapMs);
				preSight = {
					note: frameCaption(plan.count, plan.gapMs) + "\n（注意：截图来自系统屏幕；桌宠窗口本身被排除在截图外，所以画面里看不到你自己。主人问「你什么样子」时，按你对自己形象的了解回答；画面里有什么就如实说，不要回「没什么可看的」。）",
					images: frames.map((f) => Uint8Array.from(Buffer.from(f.dataUrl.split(",")[1] ?? "", "base64")))
				};
				console.log(`[dsh-whale-girl] 语音对话主动识屏：${plan.count} 帧（档位 ${sightConf.voiceVision}）`);
			} catch (e) {
				console.warn("[dsh-whale-girl] 语音识屏失败，按纯文本继续：" + (e instanceof Error ? e.message : String(e)));
			}
			const final = await chatWithPet(petId$1, asr.text, pickFastVisionModel(), false, preSight, "voice");
			if (!final.ok) return {
				kind: "json",
				status: 200,
				obj: final
			};
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					userText: asr.text,
					reply: final.text ?? "",
					audioSeconds: asr.audioSeconds,
					...final.fellBackTo === void 0 ? {} : { fellBackTo: final.fellBackTo }
				}
			};
		}
		const [scope, ...restParts] = rest.split("/");
		if (scope === "font") {
			const fontRoot = join(PACKAGE_ROOT, "assets", "fonts");
			const fontFile = resolveExisting(fontRoot, restParts.join("/"));
			if (fontFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-whale-girl: font not found"
			};
			const ext$1 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: fontFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope === "pic") {
			if (restParts[0] === "memes") {
				const segs = restParts.slice(1);
				const scoped = segs.length >= 2;
				const assetRoot = scoped ? segs[0] : "main";
				if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) return {
					kind: "text",
					status: 400,
					body: "dsh-whale-girl: invalid asset root"
				};
				const rel = (scoped ? segs.slice(1) : segs).join("/");
				let picFile$1;
				for (const dir of memeDirsFor(assetRoot)) {
					picFile$1 = resolveExisting(dir, rel);
					if (picFile$1 !== void 0) break;
				}
				if (picFile$1 === void 0) return {
					kind: "text",
					status: 404,
					body: "dsh-whale-girl: pic not found"
				};
				const ext$2 = picFile$1.slice(picFile$1.lastIndexOf(".")).toLowerCase();
				return {
					kind: "file",
					file: picFile$1,
					contentType: MIME[ext$2] ?? "application/octet-stream"
				};
			}
			const picRoot = join(PACKAGE_ROOT, "assets", "pic");
			const picFile = resolveExisting(picRoot, restParts.join("/"));
			if (picFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-whale-girl: pic not found"
			};
			const ext$1 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: picFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope !== "thumb") return {
			kind: "text",
			status: 400,
			body: "dsh-whale-girl: expected /dsh-whale-girl/thumb/<petId>/<file>"
		};
		const [petId, ...nameParts] = restParts;
		if (!petId || nameParts.length === 0) return {
			kind: "text",
			status: 400,
			body: "dsh-whale-girl: expected /dsh-whale-girl/thumb/<petId>/<file>"
		};
		if (ID_FORBIDDEN.test(petId)) return {
			kind: "text",
			status: 400,
			body: "dsh-whale-girl: invalid pet id"
		};
		const fileName = nameParts.join("/");
		const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
		if (ext !== ".webm" && ext !== ".mov") return {
			kind: "text",
			status: 400,
			body: "dsh-whale-girl: unsupported animation format (expected .webm or .mov)"
		};
		const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
		const file = extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, fileName) : resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-whale-girl: asset not found"
		};
		return {
			kind: "file",
			file,
			contentType: MIME[ext] ?? "application/octet-stream"
		};
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				if (pathname === ROUTE_PREFIX + HOTKEY_STREAM_PATH) {
					if ((req.method ?? "GET") !== "GET") {
						res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
						res.end("method not allowed");
						return;
					}
					voiceHotkeyHub.subscribe(res, voiceHotkeyStatus);
					return;
				}
				const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body);
				if (result.kind === "json") sendJson$1(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText$1(res, result.status, result.body);
				else if (result.kind === "buffer") sendBuffer(res, result.status, result.body, result.contentType);
				else sendFile(res, result.file, result.contentType);
			} catch (e) {
				sendJson$1(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-whale-girl: /dsh-whale-girl asset route");
	ctx.effect(() => () => disposeVoiceWorkers(), "dsh-whale-girl: voice workers");
	ctx.effect(() => {
		restartVoiceHotkey();
		return () => {
			voiceHotkeyWatcher?.stop();
			voiceHotkeyWatcher = void 0;
			voiceHotkeyHub.close();
		};
	}, "dsh-whale-girl: global voice hotkey");
	ctx.effect(() => {
		armSightTimer();
		return () => {
			if (sightTimer !== null) {
				clearTimeout(sightTimer);
				sightTimer = null;
			}
		};
	}, "dsh-whale-girl: sight timer");
	ctx.effect(() => {
		rearmAutoplay(readAutoplayConfig());
		return () => {
			stopEstopWatcher?.();
			stopEstopWatcher = void 0;
			playLoop.stop("dispose");
			clearThinkingBubble();
			autoplayEstop.stop("manual");
		};
	}, "dsh-whale-girl: autoplay estop");
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, currentTaskFromTodo(event));
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				const source = event?.data?.source;
				if (source?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			const next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			if (!workStatus.setState(sessionId, next, seq)) return;
			publishWorkStatus();
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-whale-girl: work-status session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on(
			"session/event",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(session, event) => {
				if (!shouldNotifySession(session)) return;
				if (isCompletionTurnEnd(event)) {
					scheduleCompletionNotify(sessionIdOf(session), event);
					return;
				}
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(frame);
			}
);
		const errorDispose = ctx.on(
			"agent/error",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(payload) => {
				pushNotifyFrame(agentErrorFrame(payload?.error));
			}
);
		return () => {
			for (const t of notifyActivityTimers.values()) clearTimeout(t);
			notifyActivityTimers.clear();
			sessionDispose();
			errorDispose();
		};
	}, "dsh-whale-girl: notify frames");
	ctx.effect(() => ctx.commands.register({
		name: "whale-balance",
		description: "手动触发鲸鱼娘余额显示（立即弹出余额气泡）",
		handler: () => {
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发鲸鱼娘余额显示"
			};
		}
	}), "dsh-whale-girl: /whale-balance command");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
			} catch {
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-whale-girl: balance poll");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId || pet.whisperEnabled !== true) continue;
					const sec = whisperPeriodSec(cfg, petId);
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) continue;
					lastWhisperAt.set(petId, now);
					publishWhisper(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
			} catch {
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-whale-girl: whisper poll");
	ctx.effect(() => ctx.commands.register({
		name: "whale-pet",
		description: "选择鲸鱼娘（/whale-chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				activePetId = String(byId.id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				activePetId = String(byName[0].id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-whale-girl: /pet command");
	ctx.effect(() => ctx.commands.register({
		name: "whale-chat",
		description: "与鲸鱼娘对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => console.warn("[dsh-whale-girl] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) console.warn("[dsh-whale-girl] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			});
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-whale-girl: /chat command");
	ctx.effect(() => () => {
		disposed = true;
		stopHelper("dsh-host-stop");
	});
	startHelper();
}

//#endregion
//#region src/standalone/server.ts
const DEFAULT_STANDALONE_PORT = 3080;
const PORT_SCAN_LIMIT = 25;
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "600"
};
/** 只取 pathname（不解码，避免 %2F 一类输入在校验之前被改写）；非法 URL 落回 '/' */
function pathnameOf(rawUrl) {
	try {
		return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
	} catch {
		return "/";
	}
}
function matches(route, pathname) {
	if (route.kind === "exact") return pathname === route.path;
	return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
function sendJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		...CORS_HEADERS,
		...headers
	});
	res.end(payload);
}
function sendText(res, status, body) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...CORS_HEADERS
	});
	res.end(body);
}
/** handler 抛错时的收口：头已发出就断连（与插件 sendFile 的错误口径一致），否则 500 JSON */
function fail(res, error, logger) {
	const message = error instanceof Error ? error.message : String(error);
	logger.error(`路由处理异常：${message}`);
	if (res.headersSent) {
		res.destroy();
		return;
	}
	sendJson(res, 500, { error: message });
}
function createRequestListener(options) {
	const { routes, logger, status, onShutdown } = options;
	return (req, res) => {
		const method = req.method ?? "GET";
		const pathname = pathnameOf(req.url);
		logger.debug(`${method} ${pathname}`);
		if (method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (pathname === "/" || pathname === "/health") {
			sendJson(res, 200, status?.() ?? { name: "dsh-whale-girl-standalone" });
			return;
		}
		if (pathname === "/shutdown") {
			sendJson(res, 200, {
				ok: true,
				stopping: true
			});
			queueMicrotask(() => onShutdown?.());
			return;
		}
		const route = routes.find((candidate) => matches(candidate, pathname));
		if (route === void 0) {
			sendText(res, 404, `dsh-whale-girl-standalone: 没有匹配的路由（已注册：${routes.map((item) => item.path).join(", ") || "无"}）`);
			return;
		}
		try {
			Promise.resolve(route.handler(req, res)).catch((error) => fail(res, error, logger));
		} catch (error) {
			fail(res, error, logger);
		}
	};
}
/** 从 preferred 起找一个能绑上的 127.0.0.1 端口；`preferred = 0` 表示交给系统分配 */
async function bindFirstFree(server, preferred, logger) {
	for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) try {
		await new Promise((accept, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				accept();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, "127.0.0.1");
		});
		const address = server.address();
		const bound = typeof address === "object" && address !== null ? address.port : port;
		if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
		return bound;
	} catch (error) {
		const code = error.code;
		if (code !== "EADDRINUSE") throw error;
	}
	throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}
async function listenStandaloneServer(options) {
	const server = createServer(createRequestListener(options));
	server.on("clientError", (_error, socket) => socket.destroy());
	const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
	options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
	return {
		port,
		async close() {
			server.closeAllConnections();
			await new Promise((accept) => server.close(() => accept()));
		}
	};
}

//#endregion
//#region src/standalone/options.ts
const USAGE = `dsh-whale-girl 独立模式（不需要 DSH）

用法：dsh-whale-girl-standalone [选项]

选项：
  --port <端口>   监听端口（默认 ${DEFAULT_STANDALONE_PORT}；被占用时自动向后顺延）
  --check         只体检：打印配置来源、宠物清单与 Electron 状态，不启动窗口
  -h, --help      显示本帮助

说明：
  桌宠在独立模式下以「透明置顶小窗」运行；浏览器内浮层需要有 DSH 网页，独立模式不提供。
  余额 / 碎碎念 / 对话 / 系统通知依赖 DSH 的服务，在独立模式下不可用。
`;
function parseArgs(argv) {
	const options = {
		port: DEFAULT_STANDALONE_PORT,
		check: false,
		help: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--check") options.check = true;
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--port" || arg.startsWith("--port=")) {
			const raw = arg === "--port" ? String(argv[index + 1] ?? "") : arg.slice(7);
			if (arg === "--port") index += 1;
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 1 || value > 65535) return { error: `--port 需要 1..65535 的整数端口，收到 ${JSON.stringify(raw)}` };
			options.port = value;
		} else return { error: `未知参数：${arg}` };
	}
	return { options };
}
function configPathsFor(root, home) {
	const userRoot = join(home, "dsh-whale-girl");
	return {
		defaultFile: join(root, "assets", "config.jsonc"),
		userFile: join(userRoot, "main-config.jsonc"),
		legacyUserFile: join(userRoot, "main-config.json"),
		petDir: join(userRoot, "pet")
	};
}
function describePets(pets) {
	if (pets.length === 0) return "（没有宠物：配置里 pets 为空）";
	return pets.map((pet) => `${String(pet.id ?? "?")}(size=${String(pet.size ?? "?")}, display=${String(pet.display ?? "?")})`).join("  ");
}
function isDesktopVisible(pet) {
	const display = pet.display;
	return display === "desktop" || display === "both";
}

//#endregion
//#region src/standalone/check.ts
function packageVersion(root) {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}
function runCheck(logger) {
	const home = dshHomeDir();
	const paths = configPathsFor(packageRoot, home);
	const electron = resolveElectronPath();
	const lines = [
		`Node            ${process.version}（${process.platform}-${process.arch}）`,
		`插件            dsh-whale-girl@${packageVersion(packageRoot)}  ${packageRoot}`,
		`DSH_HOME        ${home}`,
		`用户配置        ${paths.userFile}${existsSync(paths.userFile) ? "" : "（不存在 → 用包内默认）"}`,
		`文件宠物目录    ${paths.petDir}${existsSync(paths.petDir) ? "" : "（不存在）"}`,
		`内置默认配置    ${paths.defaultFile}${existsSync(paths.defaultFile) ? "" : "  ✗ 缺失"}`,
		`Electron        ${electron ?? `未发现（首次运行会下载到 ${electronLandingDir()}）`}`,
		`图形显示环境    ${hasGraphicalDisplay() ? "有" : "无（桌面小窗会跳过；远程桌面/Xvfb 可设 DSH_WHALE_DESKTOP_FORCE=1）"}`
	];
	const fail$1 = (message) => {
		for (const line of lines) logger.info(line);
		logger.error(message);
		return 1;
	};
	if (!existsSync(paths.defaultFile)) return fail$1("包内默认配置读不到：很可能是在**直接跑源码**（包根被解析成了 src/）。独立模式请用构建产物：npm run bundle 后 node lib/standalone.js，或 npm run standalone。");
	try {
		const merged = readAllConfig(paths);
		const entries = Object.keys(merged);
		lines.push(`配置条目        ${entries.length} 个：${entries.join(", ") || "（空）"}`);
		for (const entry of entries) {
			const conf = merged[entry] ?? {};
			const pets = Array.isArray(conf.pets) ? conf.pets : [];
			const animations = conf.animations;
			const idle = Array.isArray(animations?.idle) ? animations.idle.length : 0;
			lines.push(`  条目 ${entry}：宠物 ${pets.length} 只  ${describePets(pets)}｜idle 动画 ${idle} 个`);
		}
		const desktopVisible = flattenPetList(merged).filter(isDesktopVisible);
		lines.push(`桌面小窗        ${desktopVisible.length} 只${desktopVisible.length === 0 ? "（display 需要 desktop 或 both，否则独立模式没有可显示的宠物）" : ""}`);
		for (const line of lines) logger.info(line);
		logger.info("结论：配置与 Electron 就绪，可以直接启动（npm run standalone）。");
		return 0;
	} catch (error) {
		return fail$1(`读配置失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

//#endregion
//#region src/standalone/context.ts
const STANDALONE_PROVIDER = "standalone";
function createStandaloneLogger() {
	const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
	const write = (level, message) => {
		console.log(`[dsh-whale-girl-standalone ${stamp()}] ${level} ${message}`);
	};
	return {
		info: (message) => write("INFO ", message),
		warn: (message) => write("WARN ", message),
		error: (message) => write("ERROR", message),
		debug: (message) => {
			if (process.env.DSH_WHALE_STANDALONE_DEBUG === "1") write("DEBUG", message);
		}
	};
}
function createStandaloneContext(options) {
	const { logger } = options;
	const routes = options.routes ?? [];
	const failures = [];
	/** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
	const disposers = [];
	let disposed = false;
	const portOf = () => typeof options.port === "function" ? options.port() : options.port;
	const webServer = {
		get port() {
			return portOf();
		},
		register(spec) {
			routes.push({
				kind: spec.kind,
				path: spec.path,
				handler: spec.handler
			});
			return () => {
				const index = routes.findIndex((route) => route.handler === spec.handler);
				if (index >= 0) routes.splice(index, 1);
			};
		}
	};
	const context = {
		effect(fn) {
			try {
				const dispose = fn();
				if (typeof dispose === "function") disposers.push(dispose);
				return dispose;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(message);
				logger.error(`初始化某项失败（已跳过）：${message}`);
				return void 0;
			}
		},
		on() {
			return () => {};
		},
		logger,
		webServer,
		connection: { authenticatedUrl: (baseUrl) => baseUrl },
		commands: { register: () => () => {} },
		agentDefaultModel: { currentSelection: () => ({
			provider: STANDALONE_PROVIDER,
			model: ""
		}) },
		credentials: { resolve: async () => void 0 },
		llm: {
			listProviders: () => [],
			listModels: async () => [],
			resolveModelInfo: async () => void 0,
			stream: () => ({ [Symbol.asyncIterator]() {
				return { next: async () => {
					throw new Error("dsh-whale-girl standalone: 独立模式未接入模型（碎碎念/对话不可用）");
				} };
			} })
		}
	};
	return {
		ctx: context,
		routes,
		failures,
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const dispose of disposers.splice(0).reverse()) try {
				await dispose();
			} catch (error) {
				logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}

//#endregion
//#region src/standalone/cli.ts
/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger, options) {
	const home = dshHomeDir();
	const paths = configPathsFor(packageRoot, home);
	if (!existsSync(paths.defaultFile)) {
		logger.error(`包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。`);
		process.exitCode = 1;
		return;
	}
	const routes = [];
	const portRef = { value: options.port };
	const context = createStandaloneContext({
		port: () => portRef.value,
		logger,
		routes
	});
	let forwardShutdown = () => {};
	const server = await listenStandaloneServer({
		routes,
		logger,
		port: options.port,
		status: () => ({
			name: "dsh-whale-girl-standalone",
			plugin: {
				root: packageRoot,
				version: packageVersion(packageRoot)
			},
			port: portRef.value,
			uptimeSec: Math.round(process.uptime())
		}),
		onShutdown: () => forwardShutdown()
	});
	portRef.value = server.port;
	let shuttingDown = false;
	const shutdown = async (reason) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`收尾（${reason}）…`);
		await context.dispose();
		await server.close();
		logger.info("已退出。");
	};
	const requestShutdown = (reason) => {
		shutdown(reason).then(() => process.exit(0)).catch((error) => {
			logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
	};
	forwardShutdown = () => requestShutdown("POST /shutdown");
	process.on("SIGINT", () => requestShutdown("SIGINT"));
	process.on("SIGTERM", () => requestShutdown("SIGTERM"));
	apply(context.ctx);
	let pets = [];
	let configSource = paths.userFile;
	try {
		pets = flattenPetList(readAllConfig(paths));
		if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
	} catch (error) {
		logger.warn(`读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`);
	}
	const desktopVisible = pets.filter(isDesktopVisible);
	for (const line of [
		"",
		"===== dsh-whale-girl 独立模式（不需要 DSH）=====",
		`  插件        dsh-whale-girl@${packageVersion(packageRoot)}  ${packageRoot}`,
		`  路由        http://127.0.0.1:${server.port}/dsh-whale-girl/`,
		`  配置        ${configSource}`,
		`  宠物        ${describePets(pets)}`,
		desktopVisible.length === 0 ? "  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）" : `  桌面小窗    ${desktopVisible.length} 只`,
		"  不可用      余额 / 碎碎念 / 对话 / 系统通知（依赖 DSH 的凭证、模型与会话）",
		"  退出        Ctrl+C，或 POST /shutdown",
		""
	]) logger.info(line);
	if (context.failures.length > 0) logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
}
/** CLI 入口 */
async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if ("error" in parsed) {
		console.error(`dsh-whale-girl-standalone: ${parsed.error}\n`);
		console.error(USAGE);
		return 2;
	}
	const { options } = parsed;
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const logger = createStandaloneLogger();
	if (options.check) return runCheck(logger);
	await run(logger, options);
	return 0;
}
main().then((code) => {
	if (code !== 0) process.exit(code);
}).catch((error) => {
	console.error(`dsh-whale-girl-standalone: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});

//#endregion