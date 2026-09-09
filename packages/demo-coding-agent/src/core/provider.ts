import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Model, type Models } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/**
 * 从本包目录的 `.env` 读取环境变量(pi 本身不自动加载 .env)。不覆盖已在环境里设置的值。
 * 无 `.env` 时忽略(直接依赖真实环境变量)。
 */
export function loadDotenv(): void {
	const demoDir = dirname(fileURLToPath(import.meta.url)); // src/core/provider.ts → 包根上一层才是 .env
	const dotenvPath = join(demoDir, "..", "..", ".env");
	try {
		for (const line of readFileSync(dotenvPath, "utf8").split("\n")) {
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
	} catch {
		// .env 不存在时忽略
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
