---
"@getdomovoi/ui": patch
---

A paste of more than 40 lines into the composer now goes with the message as a text file,
`pasted-text-N.txt`, instead of filling the field. The composer draws it as the design's card with
its size and line count, Peek to read the first 40 lines the prompt carries, a remove control and
the note "Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest
on request." The expanded prompt editor converts a long paste the same way and says where it went.
A paste of 40 lines or fewer stays in the message. A paste that cannot be a file, because the
message already holds the most attachments or the text is over the 256 KB attachment limit, stays
in the message and the composer says why, and says too when the message is then over the
262,144-character prompt limit and cannot be sent. With a file attached and nothing typed, the
composer says "Add a message to send the file", since a message needs words to be sent.
