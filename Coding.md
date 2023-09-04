Before starting VsCode with this repo, don't forget to load the default values for local testing

Set these before starting VsCode:
``` shell    
    process.env.PAT='you PAT'
    process.env.GITHUB_USER='rajbos'
```

All development is currently done using unit tests. Changing this to be able to run the javascripts part locally to make development easier would be a great step.

# Publishing
Publishing a new version is done through Git Tags. You can add a tag by calling the shell command below. The `-m` option is for the message that annotates the tag.

We use semantic version as needed for the Action Marketplace.

``` shell
    git tag -a v1.0.0 -m "Version 1.0.0"
```

Next you need to push the tags to GitHub, which will trigger the `publishing` workflow.

``` shell
    git push --tags
```