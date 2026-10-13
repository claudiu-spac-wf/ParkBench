function verifySelectedDockerTarget() {
  return { verified: false };
}

module.exports = { verifySelectedDockerTarget };

if (require.main === module && process.argv.includes("--verify")) {
  verifySelectedDockerTarget();
}
