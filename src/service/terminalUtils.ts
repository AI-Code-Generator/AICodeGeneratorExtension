export function extractCommandOutput(cleanBuffer: string, command: string): string {
    if (!cleanBuffer) {
        return '';
    }

    const normalizedBuffer = cleanBuffer;
    const lastCommandIndex = normalizedBuffer.lastIndexOf(command);

    if (lastCommandIndex !== -1) {
        const afterCommand = normalizedBuffer.substring(lastCommandIndex + command.length);
        return afterCommand.trim();
    }

    return normalizedBuffer.trim();
}