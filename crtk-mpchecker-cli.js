const { createMountpointChecker } = require("./mpchecker-core");

const DEBUG = process.env.DEBUG === "1" || process.argv.includes("--debug") || process.argv.includes("-d");
const targetMountpoint = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

if (!targetMountpoint) {
  console.error("Usage: node crtk-mpchecker.js <mountpoint> [-d|--debug]");
  process.exit(1);
}

const checker = createMountpointChecker({ debug: DEBUG });

async function main() {
  try {
    const available = await checker.isMountpointAvailable(targetMountpoint);

    if (available) {
      console.log(`Mountpoint "${targetMountpoint}" is available.`);
      process.exitCode = 0;
    } else {
      console.log(`Mountpoint "${targetMountpoint}" is NOT available.`);
      process.exitCode = 2;
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exitCode = 1;
  }
}

main();
