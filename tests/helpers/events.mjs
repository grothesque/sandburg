// Event filtering and result-text helpers

export function parseJsonLines(output) {
	return output
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

export function eventsOfType(events, type) {
	return events.filter((event) => event.type === type);
}

export function findToolEnd(events, toolName) {
	return events.find((event) => event.type === "tool_execution_end" && event.toolName === toolName);
}

export function toolResultText(toolEndEvent) {
	return (toolEndEvent?.result?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function lastAssistantText(events) {
	const ends = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	const last = ends.at(-1)?.message;
	return (last?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
