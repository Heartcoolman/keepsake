/** PUBLIC STUB — the real prompt engineering (persona, tone rules, wording) lives in the
 *  private core module and is not part of this repository. These stubs keep the exact
 *  same exports and output-format contracts so the rest of the codebase builds and the
 *  MOCK_AI=1 flow works. With a real API key they produce generic, personality-free text. */

export const INTERJECTION_RATE = 0.25;

export interface PeopleCtx {
  known: { name: string; relation: string }[];
  unknownCount: number;
}

/** "妈妈(王芳)、李明" — relation first when present, bare name otherwise */
export function peopleLine(known: { name: string; relation: string }[]): string {
  return known.map((p) => (p.relation ? `${p.relation}(${p.name})` : p.name)).join('、');
}

export function analyzePrompt(allowInterjection: boolean, people?: PeopleCtx): string {
  void allowInterjection;
  const peopleBlock =
    people && (people.known.length || people.unknownCount)
      ? `\n照片中已识别的人:${peopleLine(people.known) || '(无)'};未识别人数:${people.unknownCount}。`
      : '';
  return `用户分享了一张照片。请只输出一个 JSON 对象,包含三个字段:
- "opener":看到照片后的一句自然的中文搭话,以一个开放式问题结尾。
- "imageDescription":一段 150~250 字的客观中文描述(场景、人物、物体、光线、氛围)。
- "mood":用 2~4 个字概括照片的情绪基调。${peopleBlock}
(完整人设提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export interface ProfileCtx {
  personality: string;
  memories: string[];
  mood: string;
}

export type ScenePerson = {
  name: string;
  relation: string;
  isSelf?: boolean;
};

export function chatPrompt(
  imageDescription: string,
  people: ScenePerson[] = [],
  profile?: ProfileCtx,
  selfName = '',
): string {
  void profile;
  void selfName;
  const peopleBlock = people.length ? `\n照片中的人:${peopleLine(people)}。` : '';
  return `你正在和用户聊一张 TA 分享的照片。照片参考描述:
${imageDescription}${peopleBlock}
请用中文自然地回应,每次不超过 80 字。
(完整人设与对话规则属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export function memoryExtractionPrompt(): string {
  return `下面是用户今天围绕一张照片的聊天记录、照片描述和日记。请只输出一个 JSON 对象,包含两个字段:
- "memories":数组,0~5 条,每条是 {"text":"一句话中文事实,不超过 50 字,第三人称","category":"preference|event|person|other"};没有值得记的就给空数组。
- "mood":用 2~4 个字概括用户今天的情绪;看不出来就给空字符串。
(完整提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export function relationExtractionPrompt(knownNames: string[]): string {
  return `已登记的人物名单:${knownNames.join('、') || '(暂无)'}。
下面是用户今天的聊天记录、照片描述和日记。请只输出一个 JSON 对象,包含一个字段:
- "relations":数组,0~6 条,每条是 {"person1":"姓名(本人填「我」)","person2":"姓名","label":"简短中文关系词","confidence":0~1 的小数}。只记名单中确实出现且关系明确的项;没有就给空数组。
(完整提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export function personalityConsolidationPrompt(previous: string, memories: string[]): string {
  return `请根据旧的性格印象和新累积的记忆,输出更新后的性格印象正文(80~200 字,中文,第三人称),不要任何其他内容。
【旧印象】${previous || '(还没有)'}
【新累积的记忆】
${memories.map((m) => '- ' + m).join('\n')}
(完整提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export function monthlyPrompt(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  return `下面是用户在 ${Number(y)} 年 ${Number(m)} 月写下的几篇日记。请以第一人称写一段 200~350 字的中文月度回顾,直接输出正文,不要标题或格式标记。
(完整提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}

export function diaryPrompt(
  dateStr: string,
  people: ScenePerson[] = [],
  selfName = '',
  photoMood = '',
): string {
  void selfName;
  void photoMood;
  const nameHint = people.length ? `\n可称呼的人:${peopleLine(people)}。` : '';
  return `用户会附上原照片、画面备忘和当天聊天记录。请以第一人称整理成一篇中文日记。${nameHint}
严格按以下格式输出(前两行是元信息,之后是正文):
标题:(一个不超过 12 字的标题)
心情:(2~4 字)
---
(正文 300~500 字,今天的日期是 ${dateStr}。)
(完整提示词属于私有 core 模块,此为公开构建的格式占位实现。)`;
}
