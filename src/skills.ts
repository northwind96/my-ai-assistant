/**
 * Skills Loader for agent capabilities
 * 参考 Python 版本实现: skill.py
 */

import { invoke } from "@tauri-apps/api/core";

// Skill 元数据
export interface SkillMetadata {
  description?: string;
  always?: boolean;
  requires?: {
    bins?: string[];
    env?: string[];
  };
}

// Skill 信息
export interface Skill {
  name: string;
  path: string;
  source: 'workspace' | 'builtin';
  description?: string;
  metadata?: SkillMetadata;
  content?: string;
}

// Skills 摘要 XML 格式
export interface SkillsSummary {
  xml: string;
  skills: Skill[];
}

/**
 * Skills 配置
 */
export interface SkillsConfig {
  // 用户目录下的 skills (~/.nova/skills)
  userSkillsDir: string;
  // 内置 skills 目录
  builtinSkillsDir?: string;
}

const DEFAULT_CONFIG: SkillsConfig = {
  userSkillsDir: ".nova/skills",
  builtinSkillsDir: "./skills"
};

/**
 * Skills 加载器类
 */
export class SkillsLoader {
  private config: SkillsConfig;

  constructor(config: Partial<SkillsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }


  /**
   * 列出所有可用的 skills
   */
  async listSkills(filterUnavailable: boolean = true): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      // 从用户目录加载 skills
      const userSkills = await this.loadSkillsFromDir(this.config.userSkillsDir, 'workspace');
      skills.push(...userSkills);
    } catch (e) {
      console.warn("加载用户 skills 失败:", e);
    }

    try {
      // 从内置目录加载 skills
      if (this.config.builtinSkillsDir) {
        const builtinSkills = await this.loadSkillsFromDir(this.config.builtinSkillsDir, 'builtin', skills.map(s => s.name));
        skills.push(...builtinSkills);
      }
    } catch (e) {
      console.warn("加载内置 skills 失败:", e);
    }

    // 过滤不满足需求的 skills
    if (filterUnavailable) {
      return skills.filter(s => this.checkRequirements(s.metadata));
    }

    return skills;
  }

  /**
   * 从指定目录加载 skills
   */
  private async loadSkillsFromDir(dir: string, source: 'workspace' | 'builtin', excludeNames: string[] = []): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      // 使用后端命令获取 skills 列表
      const backendSkills = await invoke<any[]>("get_skills");
      
      for (const skill of backendSkills) {
        // 跳过已存在的
        if (excludeNames.includes(skill.name)) {
          continue;
        }

        // 解析 metadata
        const metadata = this.parseFrontmatter(skill.content || '');

        skills.push({
          name: skill.name,
          path: skill.path,
          source,
          description: skill.description,
          metadata,
          content: skill.content
        });
      }
    } catch (e) {
      console.error(`从 ${dir} 加载 skills 失败:`, e);
    }

    return skills;
  }

  /**
   * 根据名称加载 skill 内容
   */
  async loadSkill(name: string): Promise<string | null> {
    const skills = await this.listSkills(false);
    const skill = skills.find(s => s.name === name);
    
    if (skill?.content) {
      return this.stripFrontmatter(skill.content);
    }

    return null;
  }

  /**
   * 为 agent context 加载多个 skills
   */
  async loadSkillsForContext(skillNames: string[]): Promise<string> {
    const parts: string[] = [];

    for (const name of skillNames) {
      const content = await this.loadSkill(name);
      if (content) {
        parts.push(`### Skill: ${name}\n\n${content}`);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 构建 skills 摘要 (XML 格式)
   */
  async buildSkillsSummary(): Promise<SkillsSummary> {
    const allSkills = await this.listSkills(false);
    
    if (!allSkills.length) {
      return { xml: '', skills: [] };
    }

    const escapeXml = (s: string): string => {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };

    const lines: string[] = ['<skills>'];
    
    for (const skill of allSkills) {
      const available = this.checkRequirements(skill.metadata);
      const desc = skill.description || skill.name;
      const missing = this.getMissingRequirements(skill.metadata);

      lines.push(`  <skill available="${available.toString()}">`);
      lines.push(`    <name>${escapeXml(skill.name)}</name>`);
      lines.push(`    <description>${escapeXml(desc)}</description>`);
      lines.push(`    <location>${escapeXml(skill.path)}</location>`);

      if (!available && missing) {
        lines.push(`    <requires>${escapeXml(missing)}</requires>`);
      }

      lines.push(`  </skill>`);
    }
    lines.push('</skills>');

    return {
      xml: lines.join('\n'),
      skills: allSkills
    };
  }

  /**
   * 获取总是启用的 skills (always=true)
   */
  async getAlwaysSkills(): Promise<string[]> {
    const skills = await this.listSkills(true);
    return skills
      .filter(s => s.metadata?.always === true)
      .map(s => s.name);
  }

  /**
   * 解析 frontmatter 元数据
   */
  parseFrontmatter(content: string): SkillMetadata | undefined {
    if (!content.startsWith('---')) {
      return undefined;
    }

    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      return undefined;
    }

    const metadata: SkillMetadata = {};
    const lines = match[1].split('\n');

    for (const line of lines) {
      if (!line.includes(':')) continue;

      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim().replace(/^["']|["']$/g, '');

      if (key.trim() === 'description') {
        metadata.description = value;
      } else if (key.trim() === 'always') {
        metadata.always = value === 'true';
      } else if (key.trim() === 'requires') {
        // 简单的 requires 解析
        try {
          metadata.requires = JSON.parse(value);
        } catch {
          // 忽略解析错误
        }
      }
    }

    return metadata;
  }

  /**
   * 移除 frontmatter
   */
  stripFrontmatter(content: string): string {
    if (content.startsWith('---')) {
      const match = content.match(/^---[\s\S]*?---\n/);
      if (match && match.index !== undefined) {
        return content.slice(match.index + match[0].length).trim();
      }
    }
    return content;
  }

  /**
   * 检查 skill 需求是否满足
   */
  checkRequirements(metadata?: SkillMetadata): boolean {
    if (!metadata?.requires) {
      return true;
    }

    const { bins, env } = metadata.requires;

    // 检查 CLI 工具
    if (bins && bins.length > 0) {
      // 由于前端无法直接检查 CLI，暂返回 true
      // 实际可以通过后端命令检查
    }

    // 检查环境变量
    if (env && env.length > 0) {
      for (const e of env) {
        if (!import.meta.env[e]) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 获取未满足的需求描述
   */
  getMissingRequirements(metadata?: SkillMetadata): string {
    if (!metadata?.requires) {
      return '';
    }

    const missing: string[] = [];
    const { env } = metadata.requires;

    // 由于前端无法检查 CLI，这里简化处理
    // 实际可以通过后端命令检查

    if (env && env.length > 0) {
      for (const e of env) {
        if (!import.meta.env[e]) {
          missing.push(`ENV: ${e}`);
        }
      }
    }

    return missing.join(', ');
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    // 缓存已移除，此方法保留以保持API兼容性
  }
}

// 导出默认实例
export const skillsLoader = new SkillsLoader();
