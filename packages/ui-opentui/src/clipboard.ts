import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export async function copyToClipboard(text: string): Promise<boolean> {
  const os = platform();

  if (os === 'darwin') {
    return runCommand('osascript', ['-e', `set the clipboard to ${toAppleScriptString(text)}`]);
  }

  if (os === 'linux') {
    if (process.env.WAYLAND_DISPLAY && (await runCommand('wl-copy', [], text))) {
      return true;
    }

    if (await runCommand('xclip', ['-selection', 'clipboard'], text)) {
      return true;
    }

    if (await runCommand('xsel', ['--clipboard', '--input'], text)) {
      return true;
    }

    return false;
  }

  if (os === 'win32') {
    return runCommand(
      'powershell.exe',
      [
        '-NonInteractive',
        '-NoProfile',
        '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'
      ],
      text
    );
  }

  return false;
}

function toAppleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function runCommand(command: string, args: string[], stdin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'ignore']
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));

    child.stdin.end(stdin ?? '');
  });
}
