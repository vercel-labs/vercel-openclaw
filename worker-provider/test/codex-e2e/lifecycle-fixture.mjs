import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export function lifecycleFixture() {
  const nickname = `otter-${randomBytes(16).toString('hex')}`;
  const fileContent = randomBytes(16).toString('hex');
  return {
    nickname, fileContent,
    messages: [
      `Remember that our public project nickname is ${nickname}. Do not put the nickname in any project file. In your project workspace, write persisted.txt containing exactly ${fileContent}. Use your native command tool to run node -e 'const fs=require("node:fs");console.log(fs.readFileSync("persisted.txt","utf8"))'. Return the file contents.`,
      'Recall our public project nickname from the previous message without guessing. Use your native command tool to read persisted.txt from the project workspace. Return both the project nickname and the file contents.',
    ],
    assertReply(reply, index) {
      assert(reply.includes(fileContent), 'Reply omits persisted file contents');
      if (index === 1) assert(reply.includes(nickname), 'Reply omits the remembered project nickname');
    },
  };
}
