/**
 * Agent Tools - OpenAI Agents SDK function tools
 * 参考 Python tools 实现，提供 shell 和文件系统工具
 */

import { invoke } from "@tauri-apps/api/core";
import { tool } from "@openai/agents";
import { z } from "zod";

// ========== Shell 执行工具 ==========

export const execTool = tool({
  name: "exec",
  description: "Execute a shell command and return its output. Use with caution.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    working_dir: z.string().optional().describe("Optional working directory for the command")
  }),
  execute: async (input: { command: string; working_dir?: string }) => {
    try {
      const result = await invoke<string>("exec_command", {
        command: input.command,
        workingDir: input.working_dir
      });
      return result;
    } catch (e) {
      return `Error: ${e}`;
    }
  }
});

// ========== 文件系统工具 ==========

export const readFileTool = tool({
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  parameters: z.object({
    path: z.string().describe("The file path to read")
  }),
  execute: async (input: { path: string }) => {
    try {
      const content = await invoke<string>("read_file", { path: input.path });
      return content;
    } catch (e) {
      return `Error: ${e}`;
    }
  }
});

export const writeFileTool = tool({
  name: "write_file",
  description: "Write content to a file at the given path. Creates parent directories if needed.",
  parameters: z.object({
    path: z.string().describe("The file path to write to"),
    content: z.string().describe("The content to write")
  }),
  execute: async (input: { path: string; content: string }) => {
    try {
      const result = await invoke<string>("write_file", {
        path: input.path,
        content: input.content
      });
      return result;
    } catch (e) {
      return `Error: ${e}`;
    }
  }
});

export const listDirTool = tool({
  name: "list_dir",
  description: "List the contents of a directory.",
  parameters: z.object({
    path: z.string().describe("The directory path to list")
  }),
  execute: async (input: { path: string }) => {
    try {
      const result = await invoke<string>("list_dir", { path: input.path });
      return result;
    } catch (e) {
      return `Error: ${e}`;
    }
  }
});

// 导出所有工具
export const agentTools = [execTool, readFileTool, writeFileTool, listDirTool];
