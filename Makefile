REGISTRY := local
SRC_FILES := $(shell find src tools -type f 2>/dev/null)
ENCLAVE_MEMORY ?= 4096

.DEFAULT_GOAL := default
.PHONY: default
default: out/nitro.eif

out:
	mkdir -p out

out/nitro.eif: $(SRC_FILES) Containerfile package.json | out
	docker build \
		--tag $(REGISTRY)/nautilus-ts \
		--platform linux/amd64 \
		--provenance=false \
		--output type=local,rewrite-timestamp=true,dest=out \
		-f Containerfile \
		.

.PHONY: run
run: out/nitro.eif
	nitro-cli run-enclave \
		--cpu-count 2 \
		--memory $(ENCLAVE_MEMORY) \
		--eif-path $(PWD)/out/nitro.eif

.PHONY: run-debug
run-debug: out/nitro.eif
	nitro-cli run-enclave \
		--cpu-count 2 \
		--memory $(ENCLAVE_MEMORY) \
		--eif-path $(PWD)/out/nitro.eif \
		--debug-mode \
		--attach-console

.PHONY: stop
stop:
	nitro-cli terminate-enclave --all

.PHONY: dev
dev:
	bun --hot src/server.ts

.PHONY: clean
clean:
	rm -rf out/
