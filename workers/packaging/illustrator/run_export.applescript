on run argv
	if (count of argv) is not 2 then error "usage: run_export.applescript worker.jsx config.json"
	set jsxFile to POSIX file (item 1 of argv)
	set jsxText to read jsxFile as «class utf8»
	set configPath to item 2 of argv
	set jsxText to "var PIPELINE_CONFIG_PATH = '" & configPath & "';" & return & jsxText
	with timeout of 480 seconds
		tell application id "com.adobe.illustrator"
			return do javascript jsxText
		end tell
	end timeout
end run
