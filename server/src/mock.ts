/** Canned AI payloads for MOCK_AI=1. v1 routes stream these via mockV1Sse (see v1/sse.ts).
 *  PUBLIC STUB — the real mock corpus (written in the product's voice) lives in the private
 *  core module. Shapes are identical; the text here is deliberately generic placeholder. */

export const MOCK_ANALYZE = {
  opener: '这张照片看起来记录了一个值得留住的瞬间。当时是在什么地方拍的呢?',
  imageDescription:
    '一张示例照片。画面构图完整,光线自然,包含若干场景元素与色彩层次,整体氛围平和。此为公开构建的占位描述文本,完整的示例语料属于私有 core 模块。',
  mood: '平静',
};

export const MOCK_CHAT_REPLIES = [
  '原来是这样,听起来当时的气氛很不错。后来呢?',
  '这个细节很有意思,你当时是什么感觉?',
  '嗯,我能想象那个画面。这段经历对你来说重要吗?',
];

export const MOCK_DIARY = `标题:一个普通的瞬间
心情:平静
---
今天翻出这张照片,和念念聊了几句。

照片里的场景并不特别,但聊着聊着,当时的一些细节又回到了眼前。有些日子就是这样,当下觉得普通,回头看才发现值得记下来。

(此为公开构建的占位日记文本,完整的示例语料属于私有 core 模块。)`;

export const MOCK_EXTRACTION = {
  memories: [
    { text: 'TA 习惯用照片记录日常生活', category: 'preference' },
    { text: 'TA 最近整理了一批旧照片', category: 'event' },
  ],
  mood: '平静',
};

export const MOCK_RELATIONS = {
  relations: [{ person1: '我', person2: '晓雯', label: '朋友', confidence: 0.92 }],
};

export const MOCK_PERSONALITY =
  'TA 喜欢记录生活,对照片背后的故事有耐心,也愿意花时间回顾和整理自己的经历。(此为公开构建的占位文本,完整的示例语料属于私有 core 模块。)';

export const MOCK_MONTHLY = `翻完这个月的日记,记下了一些平常但值得留住的片段。

这个月的记录不算多,但每一篇都对应着一个具体的瞬间。把它们放在一起看,能看出这段时间生活的大致轮廓。

(此为公开构建的占位月度回顾,完整的示例语料属于私有 core 模块。)`;
