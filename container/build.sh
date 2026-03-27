#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build Pi-mono image if pi-runner/ exists
if [ -d "$SCRIPT_DIR/pi-runner" ]; then
  PI_IMAGE_NAME="nanoclaw-pi"
  echo ""
  echo "Building Pi-mono agent container image..."
  echo "Image: ${PI_IMAGE_NAME}:${TAG}"

  ${CONTAINER_RUNTIME} build -t "${PI_IMAGE_NAME}:${TAG}" -f Dockerfile.pi .

  echo ""
  echo "Pi-mono build complete!"
  echo "Image: ${PI_IMAGE_NAME}:${TAG}"
fi

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
