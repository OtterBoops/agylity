# Build graph for the two published images.
#
# One bake invocation builds both targets, so prod-deps and the compiled bundle
# are resolved once and the two images share a single cache scope instead of the
# separate coordinator/runner scopes they used to carry.
#
#   publish      PUSH=true docker buildx bake -f docker-bake.hcl
#   PR dry run   docker buildx bake -f docker-bake.hcl --set '*.output=type=cacheonly'
#   local image  docker build --target coordinator .   (compiles via the builder stage)

variable "COORDINATOR_TAGS" {
  default = "agylity:verify"
}

variable "RUNNER_TAGS" {
  default = "agylity-runner:verify"
}

# Directory holding the prebuilt bundle as `<dir>/app/dist`, supplied by CI.
# Empty means "compile inside Docker" through the builder stage.
variable "DIST_CONTEXT" {
  default = ""
}

variable "PUSH" {
  default = "false"
}

variable "REPOSITORY" {
  default = "otterboops/agylity"
}

variable "REVISION" {
  default = ""
}

variable "VERSION" {
  default = ""
}

variable "CREATED" {
  default = ""
}

variable "BASE_IMAGE" {
  default = "base"
}

group "default" {
  targets = ["coordinator", "runner"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  contexts   = DIST_CONTEXT == "" ? {} : { dist = DIST_CONTEXT }
  args = {
    BASE_IMAGE = BASE_IMAGE
  }
  output     = ["type=image,push=${PUSH},compression=zstd,oci-mediatypes=true"]
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/${REPOSITORY}"
    "org.opencontainers.image.revision" = REVISION
    "org.opencontainers.image.version"  = VERSION
    "org.opencontainers.image.created"  = CREATED
  }
  cache-from = ["type=gha,scope=agylity"]
  cache-to   = ["type=gha,mode=max,scope=agylity"]
}

target "coordinator" {
  inherits   = ["_common"]
  target     = "coordinator"
  tags       = split(",", COORDINATOR_TAGS)
  cache-from = ["type=gha,scope=agylity", "type=gha,scope=coordinator"]
}

target "runner" {
  inherits   = ["_common"]
  target     = "runner"
  tags       = split(",", RUNNER_TAGS)
  cache-from = ["type=gha,scope=agylity", "type=gha,scope=runner"]
}
