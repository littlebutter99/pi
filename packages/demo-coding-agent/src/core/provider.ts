import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Model, type Models } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/**
 * 从当前工作目录的 `.env` 读取环境变量(pi 本身不自动加载 .env)。不覆盖已在环境里设置的值。
 * 文件不存在时提示一行后继续,直接依赖真实环境变量。
 */
export function loadDotenv(): void {
	const dotenvPath = join(process.cwd(), ".env");
	let content: string;
	try {
		content = readFileSync(dotenvPath, "utf8");
	} catch {
		console.log(`[env] 未找到 ${dotenvPath},使用已有环境变量`);
		return;
	}
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key && process.env[key] === undefined) process.env[key] = value;
	}
}

/** 某 provider 注册后产出的模型注册表与被选中的默认模型。 */
export interface ProviderBundle {
	models: Models;
	model: Model<any>;
	streamFn: StreamFn;
}

/** 注册一个真实 provider(演示固定用 DeepSeek)并挑第一个模型。 */
export function registerDeepSeek(): ProviderBundle {
	const models = createModels();
	models.setProvider(deepseekProvider());

	const model = models.getModels("deepseek")[0];
	if (!model) {
		throw new Error(
			"No DeepSeek model found. Is @earendil-works/pi-ai/providers/deepseek importable? Set DEEPSEEK_API_KEY to authenticate.",
		);
	}
	return { models, model, streamFn: models.streamSimple.bind(models) };
}
