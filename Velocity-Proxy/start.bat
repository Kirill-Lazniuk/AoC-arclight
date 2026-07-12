@echo off
java -Xms1G -Xmx1G -XX:+UseG1GC -XX:G1HeapRegionSize=4M -Dvelocity.max-known-packs=128 -XX:+UnlockExperimentalVMOptions -XX:+ParallelRefProcEnabled -XX:+AlwaysPreTouch -XX:MaxInlineLevel=15 -jar velocity.jar
pause
