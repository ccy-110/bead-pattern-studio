import { createInterface } from 'node:readline/promises'

import { PASSWORD_MIN, hashPassword } from './auth'
import { loadConfig } from './config'
import { openDb } from './db'

/**
 * 站长在服务器上手动重置密码。
 *
 * 没有邮件服务，所以不做"点击邮件里的链接找回密码" —— 那会是一个
 * 看起来能用、实际上发不出信的功能。这个脚本是诚实的替代：
 *
 *   npm run server:reset-password -- someone@example.com
 *
 * 只能在能访问数据库文件的机器上执行。
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  if (!email) {
    console.error('用法: npm run server:reset-password -- <邮箱>')
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  const db = openDb(config.dbPath)

  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as
    | { id: string; email: string }
    | undefined

  if (user === undefined) {
    console.error(`没有找到邮箱为 ${email} 的账号`)
    db.close()
    process.exitCode = 1
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const password = await rl.question(`给 ${user.email} 设置新密码（至少 ${PASSWORD_MIN} 位，输入可见）：`)
    if (password.length < PASSWORD_MIN) {
      console.error(`密码至少 ${PASSWORD_MIN} 位，未做任何修改`)
      process.exitCode = 1
      return
    }
    const again = await rl.question('再输一次：')
    if (password !== again) {
      console.error('两次输入不一致，未做任何修改')
      process.exitCode = 1
      return
    }

    const hash = await hashPassword(password)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)
    // 旧密码对应的会话全部作废
    const kicked = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
    console.log(`已重置 ${user.email} 的密码，并注销了 ${Number(kicked.changes)} 个旧会话`)
  } finally {
    rl.close()
    db.close()
  }
}

void main()
