import type { AlertSink } from './types.js';

export class TelegramAlertSink implements AlertSink {
  constructor(private readonly token: string, private readonly chatId: string) {}
  async send(message: string) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.chatId, text: message }),
    });
    if (!response.ok) throw new Error(`Telegram returned ${response.status}`);
  }
}
